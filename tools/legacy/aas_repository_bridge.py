from __future__ import annotations

import base64
import json
import math
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response


app = FastAPI(title="AAS Repository compatibility bridge", version="0.1.0")
ENGINE_BASE_URL = os.environ.get("ENGINE_BASE_URL", "http://engine:8080").rstrip("/")


def decode_submodel_id(value: str) -> str:
    try:
        padding = "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode((value + padding).encode("ascii"))
        result = decoded.decode("utf-8").strip()
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(status_code=400, detail="Invalid base64url submodel identifier.") from exc
    if not result:
        raise HTTPException(status_code=400, detail="Submodel identifier is required.")
    return result


def engine_value_url(encoded_submodel_id: str, id_short_path: str) -> str:
    query = urllib.parse.urlencode(
        {
            "submodelId": decode_submodel_id(encoded_submodel_id),
            "idShortPath": id_short_path,
        }
    )
    return f"{ENGINE_BASE_URL}/engine/aas/value?{query}"


def forward(url: str, method: str = "GET", body: bytes | None = None) -> Response:
    headers = {"Content-Type": "application/json"} if body is not None else {}
    try:
        request = urllib.request.Request(url, data=body, method=method, headers=headers)
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = response.read()
            content_type = response.headers.get("Content-Type", "application/json")
            return Response(
                content=payload,
                status_code=response.status,
                media_type=content_type.split(";", 1)[0] if payload else None,
            )
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        content_type = exc.headers.get("Content-Type", "application/json")
        return Response(
            content=payload,
            status_code=exc.code,
            media_type=content_type.split(";", 1)[0] if payload else None,
        )
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=502, detail=f"Engine AAS model unavailable: {exc}") from exc


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "UP", "source": "engine-live-aas"}


@app.get("/submodels/{encoded_submodel_id}/submodel-elements/{id_short_path:path}/$value")
def get_value(encoded_submodel_id: str, id_short_path: str) -> Response:
    return forward(engine_value_url(encoded_submodel_id, id_short_path))


@app.patch("/submodels/{encoded_submodel_id}/submodel-elements/{id_short_path:path}/$value")
async def patch_value(
    encoded_submodel_id: str,
    id_short_path: str,
    request: Request,
) -> Response:
    try:
        value: Any = await request.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="A JSON primitive value is required.") from exc
    if isinstance(value, (dict, list)) or value is None:
        raise HTTPException(status_code=400, detail="A non-null JSON primitive value is required.")
    if isinstance(value, float) and not math.isfinite(value):
        raise HTTPException(status_code=400, detail="A finite JSON number is required.")
    body = json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return forward(engine_value_url(encoded_submodel_id, id_short_path), "PATCH", body)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8081)
