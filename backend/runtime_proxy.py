from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from fastapi import HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response


def _read(url: str, *, timeout: float = 3.0) -> tuple[bytes, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read(), response.headers.get("Content-Type", "text/plain")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip() or str(exc.reason)
        raise HTTPException(status_code=exc.code, detail=detail) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=502, detail=f"Backend unavailable: {exc}") from exc


def get_text(base_url: str, path: str) -> PlainTextResponse:
    body, _ = _read(base_url.rstrip("/") + path)
    return PlainTextResponse(body.decode("utf-8", errors="replace"))


def get_json(base_url: str, path: str) -> JSONResponse:
    body, _ = _read(base_url.rstrip("/") + path)
    try:
        payload: Any = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Backend returned invalid JSON.") from exc
    return JSONResponse(payload)


def forward_json(base_url: str, path: str, *, method: str = "GET", payload: Any = None) -> Response:
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as upstream:
            raw = upstream.read()
            if not raw:
                return Response(status_code=upstream.status)
            try:
                data = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=502, detail="Backend returned invalid JSON.") from exc
            return JSONResponse(data, status_code=upstream.status)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            detail: Any = json.loads(raw) if raw else str(exc.reason)
            if isinstance(detail, dict) and isinstance(detail.get('detail'), str):
                detail = detail['detail']
        except json.JSONDecodeError:
            detail = raw.decode("utf-8", errors="replace").strip() or str(exc.reason)
        raise HTTPException(status_code=exc.code, detail=detail) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=502, detail=f"Backend unavailable: {exc}") from exc


# Set by app.py: project_model.ServiceCatalog (live registry, or the runtime project while the Runtime is stopped)
# and a function that lists the rules using a service (engine AASX + Rules page).
CATALOG = None
SERVICE_REFERENCES = None


def install_runtime_proxy(app: Any, engine_base_url: str, services_base_url: str) -> None:
    def service_definition(body, service_id=None):
        if not isinstance(body, dict) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', str(body.get('serviceId', ''))):
            raise HTTPException(400, 'A valid Service ID is required')
        if service_id is not None and body['serviceId'] != service_id: raise HTTPException(400, 'Service ID is immutable')
        adapters = {'LUA':'SCRIPT', 'BASH':'SCRIPT', 'DOCKER':'CONTAINER', 'REST':'EXTERNAL'}
        adapter, category = str(body.get('technologyAdapter') or ''), body.get('executionCategory')
        # Plugin adapters beyond the bundled four are accepted with any of the three execution categories.
        if category not in ('SCRIPT', 'CONTAINER', 'EXTERNAL') or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,40}', adapter) or (adapter in adapters and adapters[adapter] != category):
            raise HTTPException(400, 'Execution category does not match the technology adapter')
        args = body.get('defaultArgs', {})
        if not isinstance(args, dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in args.items()): raise HTTPException(400, 'defaultArgs must be an object of string values')
        if body['technologyAdapter']=='LUA' and not args.get('testContent') and not body.get('fileReference'): raise HTTPException(400, 'Lua requires defaultArgs.testContent or fileReference')
        return body
    @app.get('/api/engine/health')
    def engine_health() -> Response:
        return forward_json(engine_base_url, '/engine/health')
    @app.get('/api/engine/rules')
    def engine_rules() -> Response:
        return forward_json(engine_base_url, '/engine/rules')

    @app.post('/api/engine/rules')
    async def create_rule(request: Request) -> Response:
        return forward_json(engine_base_url, '/engine/rules', method='POST', payload=await request.json())

    @app.put('/api/engine/rules/{rule_id}')
    async def update_rule(rule_id: str, request: Request) -> Response:
        return forward_json(engine_base_url, '/engine/rules/' + urllib.parse.quote(rule_id, safe=''), method='PUT', payload=await request.json())

    @app.delete('/api/engine/rules/{rule_id}')
    def delete_rule(rule_id: str) -> Response:
        return forward_json(engine_base_url, '/engine/rules/' + urllib.parse.quote(rule_id, safe=''), method='DELETE')

    @app.post('/api/engine/rules/{rule_id}/dry-run')
    async def dry_run_rule(rule_id: str, request: Request) -> Response:
        return forward_json(engine_base_url, '/engine/rules/' + urllib.parse.quote(rule_id, safe='') + '/dry-run', method='POST', payload=await request.json())

    @app.post('/api/engine/rules/{rule_id}/test-trigger')
    async def test_trigger_rule(rule_id: str, request: Request) -> Response:
        return forward_json(engine_base_url, '/engine/rules/' + urllib.parse.quote(rule_id, safe='') + '/test-trigger', method='POST', payload=await request.json())

    @app.get('/api/engine/rule-tests/{test_id}')
    def rule_test_result(test_id: str) -> Response:
        return forward_json(engine_base_url, '/engine/rule-tests/' + urllib.parse.quote(test_id, safe=''))

    @app.get("/api/engine/state")
    def engine_state() -> PlainTextResponse:
        return get_text(engine_base_url, "/engine/state")

    @app.get("/api/engine/history")
    def engine_history() -> PlainTextResponse:
        return get_text(engine_base_url, "/engine/history")

    @app.get("/api/engine/submodel-data")
    def engine_submodel_data() -> PlainTextResponse:
        return get_text(engine_base_url, "/engine/submodel-data")

    @app.get("/api/services/history")
    def services_history() -> JSONResponse:
        return get_json(services_base_url, "/services/history")

    @app.get("/api/services/registry")
    def services_registry() -> JSONResponse:
        if CATALOG is None:
            return get_json(services_base_url, "/registry/services")
        items, source = CATALOG.list()
        return JSONResponse(items, headers={"X-Labradt-Source": source, "Cache-Control": "no-store"})

    @app.get("/api/services/health")
    def services_health() -> Response:
        return forward_json(services_base_url, "/actuator/health")

    @app.get("/api/services/running")
    def services_running() -> Response:
        return forward_json(services_base_url, "/services/running")

    @app.get("/api/services/status")
    def services_status(execution_id: str = Query(alias="executionId")) -> Response:
        return forward_json(services_base_url, "/services/status?executionId=" + urllib.parse.quote(execution_id, safe=""))

    @app.get("/api/services/result")
    def services_result(execution_id: str = Query(alias="executionId")) -> Response:
        return forward_json(services_base_url, "/services/result?executionId=" + urllib.parse.quote(execution_id, safe=""))

    @app.post("/api/services/trigger")
    async def services_trigger(request: Request) -> Response:
        return forward_json(services_base_url, "/services/trigger", method="POST", payload=await request.json())

    @app.post("/api/services/registry")
    async def services_register(request: Request) -> Response:
        definition = service_definition(await request.json())
        if CATALOG is not None:
            if any(s.get("serviceId") == definition["serviceId"] for s in CATALOG.list()[0]):
                raise HTTPException(409, f"Service '{definition['serviceId']}' already exists")
            return JSONResponse(CATALOG.upsert(definition), status_code=201)
        return forward_json(services_base_url, "/registry/services", method="POST", payload=definition)

    @app.put('/api/services/registry/{service_id}')
    async def services_update(service_id: str, request: Request) -> Response:
        definition = service_definition(await request.json(), service_id)
        if CATALOG is not None:
            CATALOG.get(service_id)
            return JSONResponse(CATALOG.upsert(definition))
        return forward_json(services_base_url, '/registry/services/' + urllib.parse.quote(service_id, safe=''), method='PUT', payload=definition)

    @app.delete("/api/services/registry/{service_id}")
    def services_delete(service_id: str) -> Response:
        if SERVICE_REFERENCES is not None:
            if SERVICE_REFERENCES(service_id):
                raise HTTPException(409, 'This Service is used by a Rule. Edit or delete the Rule first.')
        else:
            rules = json.loads(forward_json(engine_base_url, '/engine/rules').body)
            if any(service_id in [value.strip() for value in str(rule.get('action', '')).split(',')] for rule in rules):
                raise HTTPException(409, 'This Service is referenced by a Backend Rule. Edit or delete the Rule first.')
        if CATALOG is not None:
            return JSONResponse(CATALOG.delete(service_id))
        return forward_json(services_base_url, "/registry/services/" + urllib.parse.quote(service_id, safe=""), method="DELETE")
