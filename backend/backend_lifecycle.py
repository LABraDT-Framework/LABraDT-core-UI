"""Business lifecycle: keep services online, gate configuration and manual tests."""
from __future__ import annotations
import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any
from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from .runtime_proxy import forward_json
from .gateway_proxy import get_json, gateway_base


def payload(response) -> dict:
    return json.loads(response.body)


def requires_stopped(path: str, method: str) -> bool:
    if method not in {'POST', 'PUT', 'PATCH', 'DELETE'}: return False
    return (path.startswith('/api/aas/models/') or path.startswith('/api/engine/rules') or path.startswith('/api/bindings') or path.startswith('/api/workspace')
            or path.startswith('/api/gateway/configs/') and method in {'PUT', 'PATCH', 'DELETE'}
            or path.startswith('/api/gateway/plugins') and path != '/api/gateway/plugins/inspect'
            or path.startswith('/api/services/registry')
            or path == '/api/services/trigger' or path == '/api/aas/value'
            or path.startswith('/api/gateway/live/value/')
            or path in {'/api/process/gateway/start', '/api/process/gateway/stop'})


def gateway_preflight(health_url: str, directory: Path, validate_config) -> dict:
    base = gateway_base(health_url)
    loaded = payload(get_json(base, '/api/submodel/configuration'))
    if loaded.get('errors'): raise HTTPException(422, {'message': 'Gateway rejected configuration files', 'errors': loaded['errors']})
    files = {}; seen = set()
    for path in sorted(directory.glob('*.json')):
        raw = path.read_bytes()
        try: config = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as error: raise HTTPException(422, f'Invalid Gateway JSON: {path.name}') from error
        errors = validate_config(config, existing_ids=seen)
        if errors: raise HTTPException(422, {'message': f'Invalid Gateway config: {path.name}', 'errors': errors})
        seen.add(config['machineId'])
        files[path.name] = hashlib.sha256(raw).hexdigest()
    if not files: raise HTTPException(422, 'No Gateway configuration files found.')
    if loaded.get('files') != files:
        raise HTTPException(409, 'Gateway configuration changed but is not loaded. Keep Backend stopped, restart gateway with Docker Compose, then Validate / Start again.')
    health = payload(get_json(base, '/api/submodel/health'))
    return {'configurationLoaded': True, 'files': len(files), 'gatewayHealth': health}


def install_backend_lifecycle(app: Any, engine: str, health_url: str, directory: Path, validate_config, bindings=None) -> None:
    # One UI-controller worker serializes its configuration mutations with Start/Stop.
    # Direct administrative Repository/Service ports do not share this lock.
    lock = asyncio.Lock()
    workspace = None
    if bindings:
        from .backend_workspace import Workspace, install_workspace
        workspace = Workspace(bindings)
    status = lambda: payload(forward_json(engine, '/engine/runtime'))
    def require_stopped():
        current = status()
        if current.get('state') != 'STOPPED': raise HTTPException(409, 'Stop Backend before changing configuration, writing test values or running a manual Service test.')

    @app.middleware('http')
    async def lifecycle_guard(request: Request, call_next):
        path = request.url.path
        guarded = requires_stopped(path, request.method)
        transition = path.startswith('/api/backend/runtime/') and request.method == 'POST'
        if not guarded and not transition: return await call_next(request)
        async with lock:
            try:
                if guarded:
                    try: await run_in_threadpool(require_stopped)
                    except HTTPException as error:
                        # An unreachable Engine cannot be running: configuration (state zero) and the
                        # Gateway process stay editable until the Engine is up.
                        if error.status_code != 502: raise
                return await call_next(request)
            except HTTPException as error:
                return JSONResponse({'detail': error.detail}, status_code=error.status_code)

    @app.get('/api/backend/runtime')
    def runtime(): return status()

    def preflight():
        require_stopped()
        gateway = gateway_preflight(health_url, getattr(bindings, 'directory', None) or directory, validate_config)
        management = getattr(app.state, 'gateway_management', None)
        if management:
            plugins = management.catalogue()
            if not plugins['runtimeAvailable'] or any(item['status'] != 'Loaded' for item in plugins['plugins']):
                raise HTTPException(409, 'Gateway plugins are not fully loaded. Keep Backend stopped, restart Gateway and check plugin status.')
        result = payload(forward_json(engine, '/engine/runtime/validate', method='POST'))
        prepared = None
        if bindings:
            prepared = bindings.prepare({'gatewayFiles':payload(get_json(gateway_base(health_url),'/api/submodel/configuration'))['files'],
                'rules':payload(forward_json(engine,'/engine/rules')),
                'services':payload(forward_json(bindings.services,'/registry/services')), 'workspace':workspace.prepare()})
        return {**result, **gateway, **({'configurationFingerprint':prepared['fingerprint'],'bindingCount':len(prepared['configuration']['bindings']),'preparedSnapshot':prepared} if prepared else {})}

    @app.post('/api/backend/runtime/validate')
    def validate(): return preflight()

    @app.post('/api/backend/runtime/start')
    def start():
        if status().get('state') == 'RUNNING': return status()
        checked=preflight()
        result=payload(forward_json(engine, '/engine/runtime/start', method='POST'))
        if bindings:
            try: bindings.commit_run(checked['preparedSnapshot'],result)
            except Exception:
                forward_json(engine,'/engine/runtime/stop',method='POST')
                raise HTTPException(503,'Run snapshot could not be persisted; Engine stopped. Inspect configuration storage.')
        return result

    @app.post('/api/backend/runtime/stop')
    def stop():
        result=payload(forward_json(engine, '/engine/runtime/stop', method='POST'))
        if bindings: bindings.stopped()
        return result
    if bindings:
        from .backend_bindings import install_bindings
        install_bindings(app,bindings,lock,status)
        install_workspace(app,workspace,lock,status)
