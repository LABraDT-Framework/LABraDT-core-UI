"""Filesystem and endpoint configuration, resolved independently of the working directory."""
import os
from pathlib import Path

VERSION_DIR = Path(__file__).resolve().parents[1]
UI_DIR = VERSION_DIR / "frontend"
PROJECT_ROOT = VERSION_DIR.parent
FRAMEWORK_DIR = Path(os.getenv("GUC_FRAMEWORK_DIR", str(PROJECT_ROOT / "GUC_AASFramework-upload")))


PROJECTS_FILE = VERSION_DIR / "runtime" / "projects.json"  # folders chosen on the System page


def _chosen_projects() -> dict:
    try:
        import json
        data = json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _project_dir(env_var: str, *names: str) -> Path:
    """Folder of a LABraDT component project: $env_var, else the folder chosen on the System page,
    else the first existing sibling folder."""
    value = os.getenv(env_var, "").strip()
    if value:
        return Path(value).expanduser().resolve()
    key = {"LABRADT_ENGINE_DIR": "engine", "LABRADT_GATEWAY_DIR": "gateway", "LABRADT_RUNTIME_DIR": "runtime"}.get(env_var)
    chosen = str(_chosen_projects().get(key) or "").strip()
    if chosen and Path(chosen).expanduser().is_dir():
        return Path(chosen).expanduser().resolve()
    root = Path(os.getenv("LABRADT_ROOT", str(PROJECT_ROOT))).expanduser()
    for name in names:
        if (root / name).is_dir():
            return (root / name).resolve()
    return (root / names[0]).resolve()


# The three component projects configured and started by this UI (see backend/stack.py).
ENGINE_PROJECT_DIR = _project_dir("LABRADT_ENGINE_DIR", "engine-labradt-framework", "engine")
GATEWAY_PROJECT_DIR = _project_dir("LABRADT_GATEWAY_DIR", "gateway-labradt-framework", "gateway")
RUNTIME_PROJECT_DIR = _project_dir("LABRADT_RUNTIME_DIR", "runtime-labradt-framework", "services", "runtime")


def engine_aasx(engine_dir: Path) -> Path:
    """The rules AASX of an engine project: MachineTool.aasx, else the first .aasx in src/main/resources."""
    resources = Path(engine_dir) / "src" / "main" / "resources"
    preferred = resources / "MachineTool.aasx"
    if preferred.is_file():
        return preferred
    found = sorted(resources.glob("*.aasx")) if resources.is_dir() else []
    return found[0] if found else preferred


def gateway_config_dir(gateway_dir: Path) -> Path:
    return Path(gateway_dir) / "dt-gateway-app" / "src" / "main" / "resources" / "configs"


AASX_PATH = Path(os.getenv("LABRADT_AASX_PATH") or engine_aasx(ENGINE_PROJECT_DIR))
GATEWAY_DIR = GATEWAY_PROJECT_DIR
RUNTIME_DIR = VERSION_DIR / "runtime"
LOG_DIR = RUNTIME_DIR / "logs"
GATEWAY_LOG = LOG_DIR / "gateway.log"
GATEWAY_START_SCRIPT = RUNTIME_DIR / "gateway-start.cmd"
GATEWAY_APP_JAR = GATEWAY_DIR / "dt-gateway-app" / "target" / "dt-gateway-app-0.0.1-SNAPSHOT.jar"
# Machine configs live in the gateway project; the UI starts the Gateway with this folder as config path.
GATEWAY_CONFIG_DIR = Path(os.getenv("GATEWAY_CONFIG_DIR") or gateway_config_dir(GATEWAY_PROJECT_DIR))
GATEWAY_PLUGIN_DIR = Path(os.getenv('GATEWAY_PLUGIN_DIR', str(VERSION_DIR / 'data/gateway-plugins/backend')))
GATEWAY_HEALTH_URL = os.getenv("GATEWAY_HEALTH_URL", "http://127.0.0.1:8085/api/submodel/health")
ENGINE_BASE_URL = os.getenv("ENGINE_BASE_URL", "http://127.0.0.1:8080")
SERVICES_BASE_URL = os.getenv("SERVICES_BASE_URL", "http://127.0.0.1:8082")
AAS_BASE_URL = os.getenv("AAS_BASE_URL", "http://127.0.0.1:8081")
GATEWAY_DOCKER_IMAGE = os.getenv("GATEWAY_DOCKER_IMAGE", "maven:3.9-eclipse-temurin-25")
GATEWAY_CONTAINER = os.getenv("GATEWAY_CONTAINER", "guc-aas-gateway-ui")
GATEWAY_DOCKER_CONTEXT = os.getenv("GATEWAY_DOCKER_CONTEXT", "default" if os.name == "nt" else "")
GATEWAY_JAVA_ARGS = ["-Djava.net.preferIPv4Stack=true", "-Djava.net.preferIPv4Addresses=true"]
