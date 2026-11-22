"""Same-origin full-model CRUD against the official AAS V3 Repository."""
from __future__ import annotations
import json
import hashlib
import re
import threading
import urllib.parse
from typing import Any
from fastapi import HTTPException, Request
from fastapi.responses import Response, JSONResponse
from fastapi.concurrency import run_in_threadpool
from .aas_proxy import _request, encode_submodel_id

KINDS = {'shells', 'submodels', 'concept-descriptions'}
RESERVED = {'Rules_SM', 'StateChart_SM', 'CPS_SM'}
# Serializes this proxy's read/check/write operations. Direct Repository writers
# do not share this lock; this is stale-editor protection, not a database transaction.
EDITOR_LOCK = threading.RLock()

def revision(model: dict) -> str:
    canonical = json.dumps(model, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False)
    return '"' + hashlib.sha256(canonical.encode()).hexdigest() + '"'

def check_revision(original: dict, expected: str | None) -> None:
    if expected is not None and expected != revision(original):
        raise HTTPException(412, 'Model changed since this editor opened. Cancel, refresh Repository and reopen the form; nothing was saved.')

def call(base: str, path: str, method: str = 'GET', model: Any = None) -> Any:
    try:
        body = None if model is None else json.dumps(model, allow_nan=False).encode()
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error)) from error
    _, raw, _ = _request(base.rstrip('/') + path, method, body)
    return json.loads(raw) if raw else None

def collection(base: str, kind: str) -> list[dict]:
    results, cursor, seen = [], None, set()
    while True:
        page = call(base, '/' + kind + '?limit=100' + ('&cursor=' + urllib.parse.quote(cursor, safe='') if cursor else ''))
        results.extend(page.get('result', []))
        cursor = page.get('paging_metadata', {}).get('cursor')
        if not cursor: return results
        if cursor in seen: raise HTTPException(502, 'Repository returned a repeated pagination cursor')
        seen.add(cursor)

def model_path(kind: str, identifier: str = '') -> str:
    if kind not in KINDS: raise HTTPException(404, 'Unknown Repository collection')
    return '/' + kind + ('/' + encode_submodel_id(identifier) if identifier else '')

def validate(model: Any, kind: str) -> None:
    if not isinstance(model, dict) or not isinstance(model.get('id'), str) or not model['id'].strip():
        raise HTTPException(400, 'A non-empty global id is required')
    def walk(value: Any) -> None:
        if isinstance(value, dict):
            if 'idShort' in value and not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,127}', str(value['idShort'])):
                raise HTTPException(400, f"Invalid idShort: {value['idShort']}; use letters, digits and underscores")
            for child in value.values(): walk(child)
        elif isinstance(value, list):
            for child in value: walk(child)
    walk(model)
    if kind == 'shells' and not isinstance(model.get('assetInformation'), dict): raise HTTPException(400, 'assetInformation is required')

def guarded_model(base: str, kind: str, identifier: str, deleting: bool = True) -> dict:
    model = call(base, model_path(kind, identifier))
    if kind == 'submodels' and model.get('idShort') in RESERVED:
        raise HTTPException(409, 'Engine-owned submodel: edit Rules in the Rules page; CPS values via the value API; StateChart requires an AASX migration')
    if kind == 'shells' and deleting:
        reserved_ids = {sm['id'] for sm in collection(base, 'submodels') if sm.get('idShort') in RESERVED}
        if any(key.get('value') in reserved_ids for ref in model.get('submodels', []) for key in ref.get('keys', [])):
            raise HTTPException(409, 'The active Engine shell cannot be deleted or replaced while the Engine is running')
    return model

def update_model(base: str, kind: str, identifier: str, model: Any, expected: str | None = None) -> None:
    with EDITOR_LOCK:
        original = guarded_model(base, kind, identifier, False)
        check_revision(original, expected)
        validate(model, kind)
        if model['id'] != identifier: raise HTTPException(400, 'Global identifiers are immutable in this editor')
        if kind == 'shells':
            reserved_ids = {sm['id'] for sm in collection(base, 'submodels') if sm.get('idShort') in RESERVED}
            old_refs = {key.get('value') for ref in original.get('submodels', []) for key in ref.get('keys', [])} & reserved_ids
            new_refs = {key.get('value') for ref in model.get('submodels', []) for key in ref.get('keys', [])}
            if not old_refs <= new_refs: raise HTTPException(409, 'Cannot detach active Engine submodels')
        if kind == 'submodels' and model.get('idShort') in RESERVED: raise HTTPException(409, 'This idShort is reserved for the Engine')
        call(base, model_path(kind, identifier), 'PUT', model)

# The engine project's AASX (project_model.EngineAasx), set by app.py. Every change is written there too, and
# it answers in place of the repository while that is not running, so the AAS page works without it.
LOCAL = None


def live(base: str) -> bool:
    if LOCAL is None:
        return True
    return LOCAL.repository_live()


def models(base: str, kind: str) -> list[dict]:
    """All models of a kind: from the repository, or from the engine project while the repository is down."""
    if live(base):
        return collection(base, kind)
    return LOCAL.collection(kind)


def read_model(base: str, kind: str, identifier: str) -> dict:
    """One model from the repository, or from the engine project while the repository is down."""
    if live(base):
        return call(base, model_path(kind, identifier))
    return LOCAL.get(kind, identifier)


def install_repository_proxy(app: Any, base: str) -> None:
    async def read_body(request: Request) -> Any:
        raw = await request.body()
        if len(raw) > 2_000_000: raise HTTPException(413, 'Model exceeds the 2 MB editor limit')
        try: return json.loads(raw)
        except (ValueError, UnicodeDecodeError) as error: raise HTTPException(400, 'Invalid JSON model') from error

    def keep(kind: str, model: dict) -> None:
        if LOCAL is not None:
            LOCAL.put(kind, model)

    @app.get('/api/aas/environment')
    def environment() -> Response:
        if LOCAL is not None:
            LOCAL.ensure_synced()  # the repository just came up: give it the project's AAS
        if not live(base):
            return JSONResponse(LOCAL.environment(), headers={'X-Labradt-Source': 'project', 'Cache-Control': 'no-store'})
        return JSONResponse({'assetAdministrationShells': collection(base, 'shells'), 'submodels': collection(base, 'submodels'), 'conceptDescriptions': collection(base, 'concept-descriptions')},
                            headers={'X-Labradt-Source': 'repository', 'Cache-Control': 'no-store'})

    @app.get('/api/aas/models/{kind}')
    def get_model(kind: str, identifier: str) -> Response:
        model_path(kind)
        model = read_model(base, kind, identifier)
        return JSONResponse(model, headers={'ETag': revision(model), 'Cache-Control': 'no-store'})

    @app.post('/api/aas/models/{kind}', status_code=201)
    async def create(kind: str, request: Request) -> Response:
        model_path(kind)
        model = await read_body(request); validate(model, kind)
        if kind == 'submodels' and model.get('idShort') in RESERVED: raise HTTPException(409, 'This idShort is reserved for the Engine')
        if live(base):
            await run_in_threadpool(call, base, model_path(kind), 'POST', model)
        elif any(m.get('id') == model['id'] for m in LOCAL.collection(kind)):
            raise HTTPException(409, 'A model with this id already exists')
        await run_in_threadpool(keep, kind, model)
        return Response(status_code=201)

    @app.put('/api/aas/models/{kind}')
    async def update(kind: str, request: Request, identifier: str) -> Response:
        model = await read_body(request)
        if live(base):
            await run_in_threadpool(update_model, base, kind, identifier, model, request.headers.get('if-match'))
        else:
            model_path(kind)
            check_revision(LOCAL.get(kind, identifier), request.headers.get('if-match'))
            validate(model, kind)
            if model['id'] != identifier: raise HTTPException(400, 'Global identifiers are immutable in this editor')
            if kind == 'submodels' and model.get('idShort') in RESERVED: raise HTTPException(409, 'This idShort is reserved for the Engine')
        await run_in_threadpool(keep, kind, model)
        return Response(status_code=204)

    @app.delete('/api/aas/models/{kind}')
    def delete(kind: str, identifier: str) -> Response:
        model_path(kind)
        online = live(base)
        if online:
            guarded_model(base, kind, identifier)
            if kind == 'submodels':
                # Explicit detach avoids leaving dangling shell references; failures are surfaced.
                for shell in collection(base, 'shells'):
                    refs = shell.get('submodels', [])
                    filtered = [ref for ref in refs if not any(key.get('value') == identifier for key in ref.get('keys', []))]
                    if refs != filtered:
                        shell['submodels'] = filtered
                        call(base, model_path('shells', shell['id']), 'PUT', shell)
            call(base, model_path(kind, identifier), 'DELETE')
        else:
            LOCAL.get(kind, identifier)
        if LOCAL is not None:
            LOCAL.delete(kind, identifier, remember=not online)
        return Response(status_code=204)
