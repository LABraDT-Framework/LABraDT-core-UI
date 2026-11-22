from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request


BASE_URL = os.getenv("SERVICE_MANAGER_URL", "http://service-manager:8082").rstrip("/")

SERVICES = [
    {
        "serviceId": "cooling-service",
        "displayName": "Cooling Service (Engine)",
        "description": "Deterministic correction used by the bundled Engine Temperature rule.",
        "executionCategory": "SCRIPT",
        "technologyAdapter": "LUA",
        "fileReference": "",
        "defaultArgs": {
            "testContent": "return '70.0'",
        },
    },
    {
        "serviceId": "geometry-correction-service",
        "displayName": "Geometry Correction Service (Engine)",
        "description": "Deterministic correction used by the bundled Engine position rule.",
        "executionCategory": "SCRIPT",
        "technologyAdapter": "LUA",
        "fileReference": "",
        "defaultArgs": {
            "testContent": "return '0,0,0'",
        },
    },
    {
        "serviceId": "energy-monitoring-service",
        "displayName": "Energy Monitoring Service (Engine)",
        "description": "Deterministic correction used by the bundled Engine XAxisLoad rule.",
        "executionCategory": "SCRIPT",
        "technologyAdapter": "LUA",
        "fileReference": "",
        "defaultArgs": {
            "testContent": "return '25.0'",
        },
    },
    {
        "serviceId": "demoCoolingService",
        "displayName": "Cooling Service (Backend)",
        "description": "Deterministic Lua service used by the UI Engine demo.",
        "executionCategory": "SCRIPT",
        "technologyAdapter": "LUA",
        "fileReference": "",
        "defaultArgs": {
            "testContent": "return tostring(tonumber(targetTemperature) or 0)",
            "targetTemperature": "70",
            "retryLimit": "3",
        },
    },
    {
        "serviceId": "demoOffsetService",
        "displayName": "Offset Service (Backend)",
        "description": "Adds an offset to an input value in the real Service Manager.",
        "executionCategory": "SCRIPT",
        "technologyAdapter": "LUA",
        "fileReference": "",
        "defaultArgs": {
            "testContent": "return tostring((tonumber(value) or 0) + (tonumber(offset) or 0))",
            "value": "0",
            "offset": "1.5",
        },
    },
    {
        "serviceId": "demoAverageTemperatureService",
        "displayName": "Average Temperature (Backend)",
        "description": "Calculates the arithmetic mean of three numeric temperature inputs in the real Service Manager.",
        "executionCategory": "SCRIPT",
        "technologyAdapter": "LUA",
        "fileReference": "",
        "defaultArgs": {
            "testContent": (
                "local a,b,c=tonumber(temperature1),tonumber(temperature2),tonumber(temperature3) "
                "if not(a and b and c) then error('temperatures must be numeric') end "
                "return tostring((a+b+c)/3)"
            ),
            "temperature1": "20",
            "temperature2": "22",
            "temperature3": "24",
        },
    },
]


def wait_until_ready() -> None:
    for _ in range(240):
        try:
            with urllib.request.urlopen(BASE_URL + "/actuator/health", timeout=2) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(1)
    raise RuntimeError("Service Manager did not become ready in time.")


def register(definition: dict[str, object]) -> None:
    body = json.dumps(definition, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        BASE_URL + "/registry/services",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status not in (200, 201):
            raise RuntimeError(f"Registration failed with HTTP {response.status}.")


def delete(service_id: str) -> None:
    request = urllib.request.Request(
        BASE_URL + "/registry/services/" + service_id,
        method="DELETE",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status != 204:
            raise RuntimeError(f"Delete failed with HTTP {response.status}.")


def existing_service_ids() -> set[str]:
    with urllib.request.urlopen(BASE_URL + "/registry/services", timeout=10) as response:
        services = json.loads(response.read())
    return {str(service.get("serviceId")) for service in services if service.get("serviceId")}


if __name__ == "__main__":
    wait_until_ready()
    existing = existing_service_ids()
    for service in SERVICES:
        service_id = str(service["serviceId"])
        if service_id in existing:
            print(f"Preserving registered service {service_id}", flush=True)
            continue
        register(service)
        print(f"Registered {service_id}", flush=True)
