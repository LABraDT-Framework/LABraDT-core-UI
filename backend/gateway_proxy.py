from __future__ import annotations

import json
import math
import queue
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response, StreamingResponse


def gateway_base(health_url: str) -> str:
    suffix = "/api/submodel/health"
    return health_url[: -len(suffix)] if health_url.endswith(suffix) else health_url.rstrip("/")


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
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return fallback
    return fallback


def _request(url: str, method: str = "GET", body: bytes | None = None, headers: dict[str, str] | None = None, timeout: float = 5) -> tuple[int, bytes, str]:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, method=method, headers=headers or {}), timeout=timeout) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as exc:
        detail = _error_detail(exc.read(), str(exc.reason) or f"Gateway request failed ({exc.code}).")
        raise HTTPException(status_code=exc.code, detail=detail) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=502, detail=f"Gateway unavailable: {exc}") from exc


def get_json(base: str, path: str) -> JSONResponse:
    status, body, _ = _request(base + path)
    try:
        payload: Any = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Gateway returned invalid JSON.") from exc
    return JSONResponse(payload, status_code=status)


def patch_value(base: str, routing_key: str, value: Any) -> Response:
    body = json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")
    path = "/api/submodel/" + urllib.parse.quote(routing_key, safe="") + "/$value"
    status, response, content_type = _request(base + path, "PATCH", body, {"Content-Type": "application/json"})
    return Response(content=response, status_code=status, media_type=content_type.split(";", 1)[0] if response else None)


def stream_events(base: str, request: Request) -> StreamingResponse:
    async def events():
        upstream = None
        reader = None
        stop = threading.Event()
        messages: queue.Queue[tuple[str, Any]] = queue.Queue()
        try:
            upstream = await run_in_threadpool(urllib.request.urlopen, base + "/api/submodel/stream", None, 45)

            def read_upstream() -> None:
                try:
                    while not stop.is_set():
                        line = upstream.readline()
                        if not line:
                            messages.put(("eof", None))
                            return
                        messages.put(("data", line))
                except (urllib.error.URLError, TimeoutError, OSError, AttributeError, ValueError) as exc:
                    # Closing a chunked HTTPResponse during browser disconnect
                    # can clear its file pointer while readline is still running.
                    if not stop.is_set():
                        messages.put(("error", exc))

            reader = threading.Thread(target=read_upstream, name="guc-gateway-sse", daemon=True)
            reader.start()
            while True:
                if await request.is_disconnected():
                    break
                try:
                    kind, payload = await run_in_threadpool(messages.get, True, 0.25)
                except queue.Empty:
                    continue
                if kind == "data":
                    yield payload
                elif kind == "error":
                    yield f"event: error\ndata: {json.dumps({'detail': f'Gateway stream unavailable: {payload}'})}\n\n".encode()
                    break
                else:
                    break
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            yield f"event: error\ndata: {json.dumps({'detail': f'Gateway stream unavailable: {exc}'})}\n\n".encode()
        finally:
            stop.set()
            if upstream is not None:
                upstream.close()
            if reader is not None and reader.is_alive():
                await run_in_threadpool(reader.join, 0.5)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def install_gateway_proxy(app: Any, health_url: str, prefix: str = "/api/gateway") -> None:
    base = gateway_base(health_url)

    @app.get(prefix + "/live/snapshot")
    def live_snapshot() -> JSONResponse:
        return get_json(base, "/api/submodel")

    @app.get(prefix + "/live/health")
    def live_health() -> JSONResponse:
        return get_json(base, "/api/submodel/health")

    @app.get(prefix + "/live/stream")
    def live_stream(request: Request) -> StreamingResponse:
        return stream_events(base, request)

    @app.patch(prefix + "/live/value/{routing_key:path}")
    async def live_write(routing_key: str, request: Request) -> Response:
        try:
            value = await request.json()
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="A JSON primitive value is required.") from exc
        if isinstance(value, (dict, list)) or value is None or (isinstance(value, float) and not math.isfinite(value)):
            raise HTTPException(status_code=400, detail="A non-null JSON primitive value is required.")
        return await run_in_threadpool(patch_value, base, routing_key, value)
