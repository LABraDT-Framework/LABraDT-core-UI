from __future__ import annotations

import base64
import json
import math
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from fastapi import HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response


def encode_submodel_id(value: str) -> str:
    if not value or not value.strip():
        raise HTTPException(status_code=400, detail="AAS submodel identifier is required.")
    return base64.urlsafe_b64encode(value.strip().encode("utf-8")).decode("ascii").rstrip("=")


def value_url(base_url: str, submodel_id: str, id_short_path: str) -> str:
    if not id_short_path or not id_short_path.strip():
        raise HTTPException(status_code=400, detail="AAS idShort path is required.")
    encoded_path = urllib.parse.quote(id_short_path.strip(), safe="._-")
    return f"{base_url.rstrip('/')}/submodels/{encode_submodel_id(submodel_id)}/submodel-elements/{encoded_path}/$value"


def _error_detail(body: bytes, fallback: str) -> str:
    text = body.decode("utf-8", errors="replace").strip()
    if not text:
        return fallback
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(payload, dict):
        for key in ("message", "error", "detail"):
            if isinstance(payload.get(key), str) and payload[key].strip():
                return payload[key].strip()
        messages = payload.get('messages', [])
        if isinstance(messages, list) and messages and isinstance(messages[0], dict):
            return str(messages[0].get('text') or fallback)
    return fallback


def _request(url: str, method: str = "GET", body: bytes | None = None) -> tuple[int, bytes, str]:
    headers = {"Content-Type": "application/json"} if body is not None else {}
    try:
        request = urllib.request.Request(url, data=body, method=method, headers=headers)
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as exc:
        detail = _error_detail(exc.read(), str(exc.reason) or f"AAS Repository request failed ({exc.code}).")
        raise HTTPException(status_code=exc.code, detail=detail) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=502, detail=f"AAS Repository unavailable: {exc}") from exc


def get_value(base_url: str, submodel_id: str, id_short_path: str) -> JSONResponse:
    status, body, _ = _request(value_url(base_url, submodel_id, id_short_path))
    try:
        payload: Any = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="AAS Repository returned invalid JSON.") from exc
    _, metadata, _ = _request(value_url(base_url, submodel_id, id_short_path).removesuffix('/$value'))
    element = json.loads(metadata)
    if element.get('modelType') != 'Property': raise HTTPException(400, 'Scalar API only supports AAS Properties')
    try:
        if element.get('valueType') in {'xs:double', 'xs:float', 'xs:decimal'}:
            payload = float(payload)
            if not math.isfinite(payload): raise ValueError('Non-finite numeric property')
        elif element.get('valueType') in {'xs:int', 'xs:integer', 'xs:long', 'xs:short', 'xs:byte', 'xs:unsignedInt', 'xs:unsignedLong'}: payload = int(payload)
        elif element.get('valueType') == 'xs:boolean':
            if payload not in ('true', 'false', '1', '0', True, False): raise ValueError('Invalid boolean property')
            payload = payload in ('true', '1', True)
    except (ValueError, TypeError) as error:
        raise HTTPException(502, 'Repository returned a value inconsistent with its valueType') from error
    return JSONResponse(payload, status_code=status)


def patch_value(base_url: str, submodel_id: str, id_short_path: str, value: Any) -> Response:
    _, metadata, _ = _request(value_url(base_url, submodel_id, id_short_path).removesuffix('/$value'))
    element = json.loads(metadata)
    if element.get('modelType') != 'Property': raise HTTPException(400, 'Scalar API only supports AAS Properties')
    lexical = str(value) if not isinstance(value, bool) else ('true' if value else 'false')
    value_type = element.get('valueType')
    try:
        if value_type in {'xs:double', 'xs:float', 'xs:decimal'}:
            if isinstance(value, bool) or not math.isfinite(float(lexical)): raise ValueError()
        elif value_type in {'xs:int', 'xs:integer', 'xs:long', 'xs:short', 'xs:byte', 'xs:unsignedInt', 'xs:unsignedLong'}:
            if isinstance(value, bool): raise ValueError()
            number = int(lexical)
            if value_type.startswith('xs:unsigned') and number < 0: raise ValueError()
        elif value_type == 'xs:boolean':
            if lexical not in ('true','false','1','0'): raise ValueError()
    except (TypeError, ValueError, OverflowError) as error:
        raise HTTPException(400, f'Value is not valid for {value_type}') from error
    # BaSyx V3 represents Property values as lexical JSON strings, even for xs:double.
    body = json.dumps(lexical, separators=(",", ":"), allow_nan=False).encode("utf-8")
    status, response, content_type = _request(value_url(base_url, submodel_id, id_short_path), "PATCH", body)
    return Response(content=response, status_code=status, media_type=content_type.split(";", 1)[0] if response else None)


def install_aas_proxy(app: Any, base_url: str, engine_base_url: str | None = None) -> None:
    @app.get("/api/aas/value")
    def aas_read(
        submodel_id: str = Query(alias="submodelId"),
        id_short_path: str = Query(alias="idShortPath"),
    ) -> JSONResponse:
        return get_value(base_url, submodel_id, id_short_path)

    @app.patch("/api/aas/value")
    async def aas_write(
        request: Request,
        submodel_id: str = Query(alias="submodelId"),
        id_short_path: str = Query(alias="idShortPath"),
    ) -> Response:
        try:
            value = await request.json()
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="A JSON primitive value is required.") from exc
        if isinstance(value, (dict, list)) or value is None or (isinstance(value, float) and not math.isfinite(value)):
            raise HTTPException(status_code=400, detail="A non-null JSON primitive value is required.")
        # CPS_SM values belong to the Engine. Validate/evaluate there first and
        # let its durable mirror update BaSyx; arbitrary AAS properties stay repository-only.
        if engine_base_url and submodel_id == 'urn:guc:submodel:CPS_SM':
            url = engine_base_url.rstrip('/') + '/engine/aas/value?' + urllib.parse.urlencode({'submodelId': 'CPS_SM', 'idShortPath': id_short_path})
            body = json.dumps(value, allow_nan=False).encode()
            status, raw, _ = await run_in_threadpool(_request, url, 'PATCH', body)
            return Response(content=raw, status_code=status)
        return await run_in_threadpool(patch_value, base_url, submodel_id, id_short_path, value)
