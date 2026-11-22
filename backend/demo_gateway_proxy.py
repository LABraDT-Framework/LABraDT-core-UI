"""Same-origin routes to the isolated exhibition Gateway controller only."""
from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from .gateway_proxy import _request, install_gateway_proxy


ALLOWED_PATH = re.compile(r"^/api/(?:gateway/(?:configs(?:/[^/]+(?:/(?:enabled|references))?)?|plugins(?:/[^/]+)?|management/status|discover/opcua|opcua/(?:security|identity|client-certificate|server-certificate/(?:inspect|discover|confirm)))|process/gateway/(?:status|start|stop|logs))$")


def install_demo_gateway_proxy(app: Any, controller_base: str, health_url: str) -> None:
    install_gateway_proxy(app, health_url, prefix="/api/demo/api/gateway")

    @app.api_route("/api/demo/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def demo_request(path: str, request: Request) -> Response:
        upstream_path = "/api/" + path
        if not ALLOWED_PATH.fullmatch(upstream_path):
            raise HTTPException(status_code=404, detail="Only isolated Demo Gateway routes are exposed here.")
        query = "?" + request.url.query if request.url.query else ""
        chunks = []; size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if upstream_path.startswith('/api/gateway/plugins') and size > 25 * 1024 * 1024:
                raise HTTPException(413, 'Plugin package exceeds 25 MiB')
            chunks.append(chunk)
        body = b''.join(chunks)
        headers = {"Content-Type": request.headers.get("content-type", "application/json")}
        status, payload, content_type = await run_in_threadpool(
            _request, controller_base.rstrip("/") + upstream_path + query,
            request.method, body or None, headers, 15,
        )
        return Response(content=payload, status_code=status, headers={"Content-Type": content_type})
