from __future__ import annotations

import os
import json
import re
import signal
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from .gateway_proxy import install_gateway_proxy
from .runtime_proxy import install_runtime_proxy
from .aas_proxy import install_aas_proxy
from .repository_proxy import install_repository_proxy
from .template_import import install_template_import
from .backend_lifecycle import install_backend_lifecycle
from .gateway_management import GatewayManagement, install_management
from .opcua_setup import install_opcua_setup, credentials
from .stack import Stack, install_stack, reachable
from .project_archive import ProjectArchive, install_project_archive
from .project_model import EngineAasx, RulesPageSync, ServiceCatalog
from . import backend_workspace, runtime_proxy
from . import repository_proxy
from .opcua_security import create_client as create_opcua_client


from .settings import (
    VERSION_DIR,
    UI_DIR,
    PROJECT_ROOT,
    FRAMEWORK_DIR,
    GATEWAY_DIR,
    RUNTIME_DIR,
    LOG_DIR,
    GATEWAY_LOG,
    GATEWAY_START_SCRIPT,
    GATEWAY_APP_JAR,
    GATEWAY_CONFIG_DIR,
    GATEWAY_PLUGIN_DIR,
    GATEWAY_HEALTH_URL,
    ENGINE_BASE_URL,
    SERVICES_BASE_URL,
    AAS_BASE_URL,
    GATEWAY_DOCKER_IMAGE,
    GATEWAY_CONTAINER,
    GATEWAY_DOCKER_CONTEXT,
    GATEWAY_JAVA_ARGS,
    ENGINE_PROJECT_DIR,
    GATEWAY_PROJECT_DIR,
    RUNTIME_PROJECT_DIR,
    AASX_PATH,
)

app = FastAPI(title="GUC AAS Framework UI Controller", version="0.9.1")
install_gateway_proxy(app, GATEWAY_HEALTH_URL)
install_runtime_proxy(app, ENGINE_BASE_URL, SERVICES_BASE_URL)
install_aas_proxy(app, AAS_BASE_URL, ENGINE_BASE_URL)
install_repository_proxy(app, AAS_BASE_URL)
install_template_import(app)
install_opcua_setup(app)

@app.middleware('http')
async def no_stale_frontend(request: Request, call_next):
    """Always revalidate UI files, so an older UI cached for localhost:8090 is never shown."""
    response = await call_next(request)
    path = request.url.path
    if path == '/' or path.startswith(('/assets/', '/static/')):
        response.headers['Cache-Control'] = 'no-cache, must-revalidate'
    return response


@app.get('/health')
def ui_health() -> dict[str, str]:
    return {'status': 'UP'}
processes: dict[str, subprocess.Popen[Any]] = {}
runners: dict[str, str] = {}
gateway_config_changed = False

ID_SHORT = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{0,127}$")
MACHINE_ID = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,127}$")
VALUE_TYPES = {"xs:string", "xs:double", "xs:float", "xs:int", "xs:long", "xs:boolean", "xs:dateTime"}
PROTOCOLS = {"OPC_UA", "MQTT", "MODBUS", "DDS", "PROFINET"}
_DISCOVERY_DEPTH_LIMIT = 10


def ensure_runtime_dirs() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def find_maven() -> str | None:
    configured = os.getenv("MAVEN_CMD")
    if configured:
        return configured
    bundled = GATEWAY_DIR / "apache-maven-3.9.16" / "bin" / ("mvn.cmd" if os.name == "nt" else "mvn")
    if bundled.exists():
        return str(bundled)
    user_tools = Path.home() / "Tools"
    maven_name = "mvn.cmd" if os.name == "nt" else "mvn"
    candidates = sorted(user_tools.glob(f"apache-maven-*/bin/{maven_name}"), reverse=True)
    if candidates:
        return str(candidates[0])
    return shutil.which("mvn.cmd") or shutil.which("mvn")


def find_java_home() -> str | None:
    configured = os.getenv("JAVA_HOME")
    if configured and (Path(configured) / "bin" / ("java.exe" if os.name == "nt" else "java")).exists():
        return configured
    user_tools = Path.home() / "Tools"
    java_name = "java.exe" if os.name == "nt" else "java"
    candidates = sorted(user_tools.glob(f"jdk-*/bin/{java_name}"), reverse=True)
    if candidates:
        return str(candidates[0].parents[1])
    java_bin = shutil.which(java_name)
    if java_bin:
        return str(Path(java_bin).resolve().parents[1])
    return None


def find_java_command() -> str | None:
    java_home = find_java_home()
    java_name = "java.exe" if os.name == "nt" else "java"
    if java_home:
        java = Path(java_home) / "bin" / java_name
        if java.exists():
            return str(java)
    return shutil.which(java_name)


def process_environment() -> dict[str, str]:
    env = os.environ.copy()
    java_home = find_java_home()
    maven = find_maven()
    path_entries: list[str] = []
    if java_home:
        env["JAVA_HOME"] = java_home
        path_entries.append(str(Path(java_home) / "bin"))
    if maven:
        maven_home = str(Path(maven).resolve().parents[1])
        env["MAVEN_HOME"] = maven_home
        path_entries.append(str(Path(maven_home) / "bin"))
    if path_entries:
        env["PATH"] = os.pathsep.join(path_entries + [env.get("PATH", "")])
    return env


def find_docker() -> str | None:
    configured = os.getenv("DOCKER_CMD")
    if configured:
        return configured
    return shutil.which("docker")


def docker_command(*args: str) -> list[str]:
    docker = find_docker()
    if not docker:
        return []
    command = [docker]
    if GATEWAY_DOCKER_CONTEXT:
        command.extend(["--context", GATEWAY_DOCKER_CONTEXT])
    command.extend(args)
    return command


def gateway_process() -> subprocess.Popen[Any] | None:
    proc = processes.get("gateway")
    if proc and proc.poll() is None:
        return proc
    processes.pop("gateway", None)
    runners.pop("gateway", None)
    return None


def docker_container_running() -> bool:
    command = docker_command("inspect", "-f", "{{.State.Running}}", GATEWAY_CONTAINER)
    if not command:
        return False
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=3,
    )
    return result.returncode == 0 and result.stdout.strip().lower() == "true"


def gateway_maven_script(mvn: str = "mvn") -> str:
    return (
        f"{mvn} -o -pl dt-gateway-app -am -DskipTests install && "
        f"{mvn} -o -pl dt-gateway-app spring-boot:run "
        '-Dspring-boot.run.arguments="--server.port=8085 --dt.ui.enabled=false"'
    )


def gateway_windows_maven_script(mvn: str) -> str:
    return (
        f'call "{mvn}" -pl dt-gateway-app -am -DskipTests install && '
        f'call "{mvn}" -pl dt-gateway-app spring-boot:run '
        '-Dspring-boot.run.arguments="--server.port=8085 --dt.ui.enabled=false"'
    )


def gateway_local_script(mvn: str | None = None, force_rebuild: bool = False) -> str:
    build_command = ""
    if mvn:
        if force_rebuild:
            build_command = f'{mvn} -o -pl dt-gateway-app -am -DskipTests install && '
        else:
            build_command = (
                f'test -f "{GATEWAY_APP_JAR}" || '
                f'{mvn} -o -pl dt-gateway-app -am -DskipTests install && '
            )
    return (
        build_command
        + f'"{find_java_command() or "java"}" {" ".join(GATEWAY_JAVA_ARGS)} -jar "{GATEWAY_APP_JAR}" --server.port=8085 --dt.ui.enabled=false'
    )


def write_gateway_windows_script(mvn: str, force_rebuild: bool = False) -> Path:
    ensure_runtime_dirs()
    java_home = find_java_home()
    maven_home = str(Path(mvn).resolve().parents[1])
    lines = [
        "@echo off",
        "setlocal",
    ]
    if java_home:
        lines.append(f'set "JAVA_HOME={java_home}"')
    lines.extend(
        [
            f'set "MAVEN_HOME={maven_home}"',
            f'set "PATH={Path(maven_home) / "bin"};%JAVA_HOME%\\bin;%PATH%"',
            f'cd /d "{GATEWAY_DIR}"',
            (f'call "{mvn}" -o -pl dt-gateway-app -am -DskipTests install'
             if force_rebuild else f'if not exist "{GATEWAY_APP_JAR}" call "{mvn}" -o -pl dt-gateway-app -am -DskipTests install'),
            "if errorlevel 1 exit /b %errorlevel%",
            f'"{find_java_command() or "java"}" {" ".join(GATEWAY_JAVA_ARGS)} -jar "{GATEWAY_APP_JAR}" --server.port=8085 --dt.ui.enabled=false',
        ]
    )
    GATEWAY_START_SCRIPT.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
    return GATEWAY_START_SCRIPT


def read_gateway_health() -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(GATEWAY_HEALTH_URL, timeout=1.5) as response:
            body = response.read().decode("utf-8", errors="replace")
            return {"reachable": True, "status_code": response.status, "body": body}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"reachable": False, "error": str(exc)}


def status_payload() -> dict[str, Any]:
    proc = gateway_process()
    docker_running = False if proc else docker_container_running()
    health = read_gateway_health()
    health_running = bool(health and health.get("reachable"))
    tracked_running = bool(proc) or docker_running
    runner = runners.get("gateway") or ("docker" if docker_running else None)
    if health_running and not tracked_running:
        runner = "external"
    return {
        "component": "gateway",
        "running": tracked_running or health_running,
        "tracked": tracked_running,
        "pid": proc.pid if proc else None,
        "returncode": proc.poll() if proc else None,
        "runner": runner,
        "health": health,
        "log_file": str(GATEWAY_LOG),
        "gateway_dir": str(GATEWAY_DIR),
        "docker_container": GATEWAY_CONTAINER,
        "java_home": find_java_home(),
        "java": find_java_command(),
        "maven": find_maven(),
        "configuration_restart_required": gateway_config_changed,
    }


def config_file(machine_id: str) -> Path:
    if not MACHINE_ID.fullmatch(machine_id):
        raise HTTPException(status_code=400, detail="machineId may contain only letters, numbers, _ and -")
    return stack.config_dir / f"{machine_id}.json"  # the gateway project chosen on the System page


def read_machine_config(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Could not read {path.name}: {exc}") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail=f"{path.name} does not contain a JSON object")
    return payload


def validate_machine_config(payload: Any, *, existing_ids: set[str] | None = None) -> list[str]:
    if not isinstance(payload, dict):
        return ["Configuration must be a JSON object."]
    errors: list[str] = []
    machine_id = str(payload.get("machineId", ""))
    if not MACHINE_ID.fullmatch(machine_id):
        errors.append("machineId is required and may contain only letters, numbers, _ and -.")
    elif existing_ids and machine_id in existing_ids:
        errors.append(f"machineId '{machine_id}' is already used by another configuration.")
    if payload.get("protocol") not in PROTOCOLS:
        errors.append("protocol must be supported by the Gateway protocol enum.")
    connection = payload.get("connection")
    if not isinstance(connection, dict) or not str(connection.get("endpoint", "")).strip():
        errors.append("connection.endpoint is required.")
    elif payload.get('protocol') == 'OPC_UA':
        if not connection['endpoint'].startswith('opc.tcp://'):
            errors.append('OPC UA endpoint must start with opc.tcp://.')
        if connection.get('securityPolicy', 'None') != 'None':
            if connection.get('securityMode', 'SignAndEncrypt') not in ('Sign', 'SignAndEncrypt'):
                errors.append('Secured OPC UA requires Sign or SignAndEncrypt.')
            if not connection.get('serverCertificate'):
                errors.append('Select a verified server certificate for secured OPC UA.')
    mappings = payload.get("mappings")
    if not isinstance(mappings, list) or not mappings:
        errors.append("At least one signal mapping is required.")
        return errors
    names: set[str] = set()
    for index, mapping in enumerate(mappings, start=1):
        if not isinstance(mapping, dict):
            errors.append(f"Mapping {index} must be an object.")
            continue
        address = str(mapping.get("sourceAddress", "")).strip()
        id_short = str(mapping.get("idShort", "")).strip()
        value_type = mapping.get("valueType")
        if not address:
            errors.append(f"Mapping {index} is missing sourceAddress.")
        if not ID_SHORT.fullmatch(id_short):
            errors.append(f"Mapping {index} has an invalid AAS idShort '{id_short}'.")
        elif id_short in names:
            errors.append(f"Mapping {index} repeats idShort '{id_short}'.")
        else:
            names.add(id_short)
        if value_type not in VALUE_TYPES:
            errors.append(f"Mapping {index} has unsupported valueType '{value_type}'.")
    return errors


def gateway_connection_references(machine: str) -> list[dict]:
    bindings = globals().get('backend_bindings')
    if bindings is None: return []  # Demo AAS/rule references are checked in its browser workspace.
    result = [{'kind': 'AAS mapping', 'id': b['id'], 'name': b.get('name', b['id'])} for b in bindings.store.read()['bindings'] if b.get('signalKey', '').startswith(machine + '.')]
    if machine == os.getenv('ENGINE_MACHINE_ID', 'cnc-line1') and bindings.rules_getter:
        result += [{'kind': 'Java Engine rule', 'id': rule.get('idShort', ''), 'name': rule.get('description', rule.get('idShort', ''))} for rule in bindings.rules_getter()]
    return result


gateway_management = GatewayManagement(GATEWAY_CONFIG_DIR, GATEWAY_PLUGIN_DIR, GATEWAY_HEALTH_URL, validate_machine_config, gateway_connection_references,
    host_jar=os.getenv('GATEWAY_PLUGIN_HOST_JAR', '/opt/plugin-host/target/gateway-plugin-host-0.9.1.jar'), java_plugins=os.getenv('GATEWAY_JAVA_PLUGIN_DIR', '/gateway-plugins'))
install_management(app, gateway_management)


def browse_opcua_nodes(endpoint: str, username: str | None = None, password: str | None = None, connection: dict | None = None) -> list[dict[str, Any]]:
    """Read selectable variables from an OPC UA server, matching the project wizard's behaviour."""
    try:
        from asyncua import ua
        from asyncua.sync import Client
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="OPC UA browsing requires the asyncua Python package.") from exc

    from .opcua_security import create_client
    client = create_client(connection or {'endpoint': endpoint, 'username': username, 'password': password})
    found: list[dict[str, Any]] = []
    seen: set[str] = set()

    def value_type(value: Any) -> str:
        if isinstance(value, bool):
            return "xs:boolean"
        if isinstance(value, int):
            return "xs:int"
        if isinstance(value, float):
            return "xs:double"
        return "xs:string"

    def access_info(node: Any) -> dict[str, Any]:
        """Return the effective access granted to the connected OPC UA user."""
        try:
            levels = node.get_user_access_level()
        except Exception:
            try:
                levels = node.get_access_level()
            except Exception:
                levels = set()
        names = {getattr(level, "name", str(level)) for level in (levels or set())}
        writable = "CurrentWrite" in names
        return {
            "readable": True,
            "writable": writable,
            "accessLevel": "Read / Write" if writable else "Read only",
        }

    def walk(node: Any, depth: int = 0) -> None:
        if depth > _DISCOVERY_DEPTH_LIMIT:
            return
        try:
            children = node.get_children()
        except Exception:
            return
        for child in children:
            try:
                node_class = child.read_node_class()
            except Exception:
                continue
            if node_class == ua.NodeClass.Variable:
                try:
                    address = child.nodeid.to_string()
                    if child.nodeid.NamespaceIndex == 0 or address in seen:
                        continue
                    name = child.read_browse_name().Name
                    value = child.read_value()
                except Exception:
                    continue
                if value is None or isinstance(value, ua.NodeId):
                    continue
                seen.add(address)
                found.append({"sourceAddress": address, "name": name, "valueType": value_type(value), "value": str(value), **access_info(child)})
            elif node_class == ua.NodeClass.Object:
                walk(child, depth + 1)

    try:
        client.connect()
        walk(client.nodes.objects)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not browse OPC UA server: {exc}") from exc
    finally:
        try:
            client.disconnect()
        except Exception:
            pass
    return sorted(found, key=lambda node: (node["name"] or "", node["sourceAddress"]))


@app.get("/")
def index() -> FileResponse:
    return FileResponse(UI_DIR / "index.html")


@app.get("/api/process/gateway/status")
def gateway_status() -> dict[str, Any]:
    return legacy_gateway_status()


@app.get("/api/gateway/configs")
def list_gateway_configs() -> list[dict[str, Any]]:
    return gateway_management.entries()


@app.post("/api/gateway/configs/validate")
def validate_gateway_config(payload: dict[str, Any]) -> dict[str, Any]:
    if isinstance(payload.get('connection'), dict):
        saved = {}
        machine = str(payload.get('machineId') or '')
        if MACHINE_ID.fullmatch(machine):
            try:
                path, _ = gateway_management.locate(machine)
                existing = json.loads(path.read_text(encoding='utf-8'))
                if existing.get('protocol') == payload.get('protocol'): saved = existing.get('connection', {})
            except HTTPException as error:
                if error.status_code != 404: raise
        try: payload = {**payload, 'connection': credentials(payload['connection'], saved)}
        except HTTPException as error: return {'valid': False, 'errors': [error.detail]}
    return {"valid": not (errors := validate_machine_config(payload)), "errors": errors}


@app.put("/api/gateway/configs/{machine_id}")
def save_gateway_config(machine_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    global gateway_config_changed
    result = gateway_management.save(machine_id, payload)
    gateway_config_changed = True
    return result


@app.delete("/api/gateway/configs/{machine_id}")
def delete_gateway_config(machine_id: str) -> dict[str, Any]:
    global gateway_config_changed
    result = gateway_management.delete(machine_id)
    gateway_config_changed = True
    return result


def opcua_connection(payload: dict[str, Any]) -> dict[str, Any]:
    """OPC UA connection for browsing / exploring, with the saved credentials of that machine's exact endpoint."""
    endpoint = str(payload.get("endpoint", "")).strip()
    if not endpoint.startswith("opc.tcp://"):
        raise HTTPException(status_code=400, detail="OPC UA endpoint must start with opc.tcp://")
    connection = {key: payload[key] for key in ('endpoint', 'securityPolicy', 'securityMode', 'serverCertificate', 'usernameEnv', 'passwordEnv', 'username', 'password', 'authentication', 'passwordSet') if key in payload}
    saved = {}
    # Saved credentials are usable only for that machine's exact saved endpoint.
    machine_id = str(payload.get('machineId') or '')
    if machine_id and MACHINE_ID.fullmatch(machine_id):
        try: path, _ = gateway_management.locate(machine_id)
        except HTTPException as error:
            if error.status_code != 404: raise
            path = gateway_management.path(machine_id)
        if path.is_file():
            saved = json.loads(path.read_text(encoding='utf-8')).get('connection', {})
            if saved.get('endpoint') != endpoint: saved = {}
            if any(key in connection and connection[key] != saved.get(key) for key in ('username', 'usernameEnv', 'passwordEnv')):
                saved = {}
            if 'authentication' not in connection: connection = {**saved, **connection}
    return credentials(connection, saved)


@app.post("/api/gateway/discover/opcua")
def discover_opcua(payload: dict[str, Any]) -> dict[str, Any]:
    connection = opcua_connection(payload)
    endpoint = connection["endpoint"]
    nodes = browse_opcua_nodes(endpoint, connection=connection)
    return {"endpoint": endpoint, "count": len(nodes), "nodes": nodes}


# The Overview Gateway card keeps its routes; the process itself is managed by the
# stack controller (backend/stack.py), which runs the gateway project with Maven.
def legacy_gateway_status(message: str | None = None) -> dict[str, Any]:
    comp = stack.component("gateway").status()
    health = read_gateway_health()
    result = {
        "component": "gateway", "running": comp["running"], "tracked": comp["tracked"], "pid": comp["pid"],
        "returncode": comp["exitCode"], "runner": "local" if comp["tracked"] else ("external" if comp["external"] else None),
        "phase": comp["phase"], "health": health, "log_file": comp["logFile"], "gateway_dir": comp["project"],
        "maven": comp["maven"], "java_home": find_java_home(), "configuration_restart_required": gateway_config_changed,
    }
    if message or comp["message"]:
        result["message"] = message or comp["message"]
    return result


@app.post("/api/process/gateway/start")
def start_gateway() -> JSONResponse:
    global gateway_config_changed
    try:
        result = stack.component("gateway").start()
    except HTTPException as error:
        return JSONResponse({**legacy_gateway_status(), "error": error.detail}, status_code=error.status_code)
    gateway_config_changed = False
    return JSONResponse(legacy_gateway_status(result.get("message")))


@app.post("/api/process/gateway/stop")
def stop_gateway() -> dict[str, Any]:
    return legacy_gateway_status(stack.component("gateway").stop().get("message"))


@app.get("/api/process/gateway/logs")
def gateway_logs(lines: int = 160) -> PlainTextResponse:
    return PlainTextResponse(stack.component("gateway").logs(lines))




if os.getenv('BACKEND_CONTROL_ENABLED', 'true').lower() == 'true':
    from .backend_bindings import BackendBindings, Store
    from .runtime_proxy import forward_json
    def binding_write_access(signal):
        from .opcua_security import create_client
        client=create_client(signal['config']['connection'],timeout=2)
        try:
            client.connect();levels=client.get_node(signal['sourceAddress']).get_user_access_level()
            return any(getattr(level,'name','')=='CurrentWrite' for level in levels)
        except Exception: return False
        finally:
            try: client.disconnect()
            except Exception: pass
    backend_bindings=BackendBindings(Store(os.getenv('BACKEND_STORE_PATH',str(RUNTIME_DIR/'backend-config.json'))),AAS_BASE_URL,GATEWAY_HEALTH_URL,GATEWAY_CONFIG_DIR,binding_write_access)
    backend_bindings.services=SERVICES_BASE_URL
    def engine_rules() -> list:
        """The Engine's rules: live from the Engine, else from the engine project's AASX (the Engine may be stopped)."""
        try:
            return json.loads(forward_json(ENGINE_BASE_URL,'/engine/rules').body)
        except HTTPException:
            try:
                return stack.aasx.rules()
            except (HTTPException, NameError):
                return []
    backend_bindings.rules_getter=engine_rules
    install_backend_lifecycle(app, ENGINE_BASE_URL, GATEWAY_HEALTH_URL, GATEWAY_CONFIG_DIR, validate_machine_config,backend_bindings)

stack = Stack(engine_dir=ENGINE_PROJECT_DIR, gateway_dir=GATEWAY_PROJECT_DIR, runtime_dir=RUNTIME_PROJECT_DIR,
              engine_url=ENGINE_BASE_URL, gateway_health_url=GATEWAY_HEALTH_URL, services_url=SERVICES_BASE_URL,
              gateway_config_dir=GATEWAY_CONFIG_DIR, aasx_path=AASX_PATH, state_dir=RUNTIME_DIR,
              browse_opcua=lambda endpoint, username=None, password=None: browse_opcua_nodes(endpoint, username, password),
              opcua_client=lambda payload: create_opcua_client(opcua_connection(payload)))
install_stack(app, stack)
gateway_management.project_plugins = stack.plugins.catalogue_entries


def follow_projects(current: Stack) -> None:
    """Other modules keep the gateway config folder; point them at the newly chosen gateway project."""
    gateway_management.configs = current.config_dir
    bindings = globals().get("backend_bindings")
    if bindings is not None:
        bindings.directory = current.config_dir


stack.project_listeners.append(follow_projects)


def aas_put(kind: str, model: dict) -> None:
    """Create or replace one AAS model in the repository (project import)."""
    path = repository_proxy.model_path(kind, model["id"])
    try:
        repository_proxy.call(AAS_BASE_URL, path, "PUT", model)
    except HTTPException as error:
        if error.status_code != 404:
            raise
        repository_proxy.call(AAS_BASE_URL, repository_proxy.model_path(kind), "POST", model)


def aas_delete(kind: str, identifier: str) -> None:
    repository_proxy.call(AAS_BASE_URL, repository_proxy.model_path(kind, identifier), "DELETE")


AAS_REPOSITORY = {
    "collection": lambda kind: repository_proxy.collection(AAS_BASE_URL, kind),
    "put": aas_put,
    "delete": aas_delete,
    "reachable": lambda: reachable(AAS_BASE_URL + "/shells", timeout=1.5),
}

# Project-first persistence (backend/project_model.py): what the Services, Rules and AAS pages configure is
# written into the component projects, whether or not the Runtime, the Engine or the AAS repository is running.
service_catalog = ServiceCatalog(stack, RUNTIME_DIR / "services-snapshot.json")
engine_aasx = EngineAasx(stack, AAS_REPOSITORY)
rules_sync = RulesPageSync(stack, engine_aasx.submodel_or_repository)
stack.catalog = service_catalog
runtime_proxy.CATALOG = service_catalog
repository_proxy.LOCAL = engine_aasx
backend_workspace.CATALOG = service_catalog
backend_workspace.RULES_SYNC = rules_sync.sync


def workspace_rules() -> list[dict]:
    try:
        return (backend_bindings.store.read().get("workspace") or {}).get("rules", []) if "backend_bindings" in globals() else []
    except HTTPException:
        return []


def rules_page_references(service_id: str) -> list[dict]:
    return [{"source": "Rules page", "id": r.get("id"), "description": r.get("name", "")} for r in workspace_rules()
            if (r.get("serviceCall") or {}).get("serviceId") == service_id]


def service_references(service_id: str) -> list[dict]:
    return stack.coupled_rules(service_id)


stack.rules_page_references = rules_page_references
runtime_proxy.SERVICE_REFERENCES = service_references

project_archive = ProjectArchive(stack, Path(os.getenv("BACKEND_STORE_PATH", str(RUNTIME_DIR / "backend-config.json"))), engine_aasx, service_catalog)
stack.apply_hooks["aas"] = engine_aasx.sync
install_project_archive(app, project_archive)


@app.get("/api/project/status")
def project_status() -> dict:
    """Which servers run: the pages show whether a change went live or only into the projects."""
    return {"runtime": stack.components["runtime"].health(), "engine": stack.components["engine"].health(),
            "gateway": stack.components["gateway"].health(), "repository": engine_aasx.repository_live(),
            "aasx": str(stack.aasx.path), "runtimeProject": str(stack.runtime_dir)}

app.mount("/assets", StaticFiles(directory=str(UI_DIR / "assets")), name="assets")
app.mount("/static", StaticFiles(directory=str(UI_DIR)), name="static")

