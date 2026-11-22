"""LABraDT stack control: the tasks of tools-labradt-framework/unified_cli.py as a REST API.

The UI controller configures and starts the three component projects that sit next
to this UI folder (or wherever LABRADT_*_DIR point):

  runtime   runtime-labradt-framework   Service Manager   port 8082
  gateway   gateway-labradt-framework   DT Gateway        port 8085
  engine    engine-labradt-framework    DT Engine         port 8080

System Integrator tasks (unified_cli.py menu 1):
  * Gateway: install a ready machine config, browse a live machine (OPC UA / MQTT)
    and create a config, credential placeholders instead of passwords
  * Engine: list / add / set / delete rules in MachineTool.aasx, verify, backup
  * Service: register (incl. script / Dockerfile upload to engine storage), list,
    delete (with rule coupling check and storage clean-up), nested service guide

Operator tasks (unified_cli.py menu 2):
  * start / stop / status / logs of runtime, gateway and engine (Maven, from the
    project folders), start / stop of the whole stack in dependency order
  * engine initialize, shutdown, state, transition history, simulated sensor push
  * service trigger (several at once, dynamic args), running, history, status,
    result and stop of an execution

Everything here uses the Python standard library; browsing a live machine needs
the optional packages asyncua (OPC UA) and paho-mqtt (MQTT), as in the CLI.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from xml.sax.saxutils import escape as xml_escape, unescape as xml_unescape

from fastapi import HTTPException, Query, Request, Response

IS_WINDOWS = os.name == "nt"

# ─────────────────────────────────────────────────────────────────────────────
# Gateway config validation (ported from unified_cli.py)
# ─────────────────────────────────────────────────────────────────────────────

XS_TYPES = ["xs:string", "xs:double", "xs:int", "xs:boolean", "xs:float", "xs:long", "xs:dateTime"]
CLI_PROTOCOLS = ["OPC_UA", "MQTT"]
PLUGIN_PROTOCOLS = ["MODBUS", "DDS", "PROFINET"]
KNOWN_TOP_KEYS = {"machineId", "machineType", "protocol", "comment", "connection", "mappings"}
KNOWN_CONNECTION_KEYS = {"endpoint", "username", "password", "securityPolicy", "securityMode", "serverCertificate",
                         "usernameEnv", "passwordEnv", "reconnectInitialBackoffMs", "reconnectMaxBackoffMs",
                         "quietWindowMs", "topicFilter", "authentication"}
KNOWN_MAPPING_KEYS = {"sourceAddress", "idShort", "valueType", "category", "semanticId", "unit", "sourceUnit",
                      "targetUnit", "validRange", "valueMap", "deadband", "comment", "protocol", "readable", "writable"}
CATEGORIES = {"CONSTANT", "PARAMETER", "VARIABLE"}
IDSHORT_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]*$")
MACHINE_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.json$")
PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}")


def credential_env_names(machine_id: str) -> tuple[str, str]:
    """molder-2 -> (DT_MOLDER_2_USERNAME, DT_MOLDER_2_PASSWORD)."""
    stem = re.sub(r"[^A-Z0-9]+", "_", str(machine_id).upper()).strip("_")
    return f"DT_{stem}_USERNAME", f"DT_{stem}_PASSWORD"


def is_env_placeholder(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("${") and value.endswith("}") and len(value) > 3


def validate_config(doc: Any, taken_ids: set[str]) -> tuple[list[str], list[str]]:
    """Same rules as unified_cli.validate_config; plugin protocols are a warning."""
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(doc, dict):
        return ["top level must be a JSON object"], []
    mid = doc.get("machineId")
    if not mid or not isinstance(mid, str) or not mid.strip():
        errors.append("missing required field 'machineId'")
    elif " " in mid or "/" in mid or "\\" in mid:
        errors.append(f"machineId '{mid}' must not contain spaces or slashes")
    elif mid in taken_ids:
        errors.append(f"machineId '{mid}' is already in use")
    proto = doc.get("protocol")
    if not proto:
        errors.append("missing required field 'protocol'")
    elif proto in PLUGIN_PROTOCOLS:
        warnings.append(f"protocol '{proto}' needs an installed Gateway plugin")
    elif proto not in CLI_PROTOCOLS:
        errors.append(f"protocol '{proto}' not supported - use one of {CLI_PROTOCOLS + PLUGIN_PROTOCOLS}")
    conn = doc.get("connection")
    if not isinstance(conn, dict) or not str(conn.get("endpoint") or "").strip():
        errors.append("missing required field 'connection.endpoint'")
    elif isinstance(conn, dict):
        for key in conn:
            if key not in KNOWN_CONNECTION_KEYS:
                warnings.append(f"unknown connection key '{key}' (typo?)")
        password = conn.get("password")
        if password and not is_env_placeholder(password):
            pass_var = credential_env_names(str(mid or "machine"))[1]
            errors.append("connection.password holds a plain password - replace it with "
                          f"\"${{{pass_var}}}\" (set {pass_var} for the Gateway) or use passwordEnv")
    mappings = doc.get("mappings")
    if not isinstance(mappings, list) or not mappings:
        errors.append("'mappings' is missing or empty")
    else:
        seen: set[str] = set()
        for i, m in enumerate(mappings, 1):
            if not isinstance(m, dict):
                errors.append(f"mapping #{i} is not an object")
                continue
            if not str(m.get("sourceAddress") or "").strip():
                errors.append(f"mapping #{i} missing 'sourceAddress'")
            el = str(m.get("idShort") or "").strip()
            if not el:
                errors.append(f"mapping #{i} missing 'idShort'")
            elif el in seen:
                errors.append(f"duplicate idShort '{el}'")
            else:
                seen.add(el)
            if el and not IDSHORT_RE.match(el):
                errors.append(f"mapping '{el}': idShort must match [a-zA-Z][a-zA-Z0-9_]*")
            vt = m.get("valueType")
            if not vt:
                errors.append(f"mapping '{el or i}' missing 'valueType'")
            elif vt not in XS_TYPES:
                errors.append(f"mapping '{el or i}': valueType '{vt}' not one of {XS_TYPES}")
            cat = m.get("category")
            if cat is not None and cat not in CATEGORIES:
                errors.append(f"mapping '{el or i}': category '{cat}' not one of {sorted(CATEGORIES)}")
            for key in m:
                if key not in KNOWN_MAPPING_KEYS:
                    warnings.append(f"mapping '{el or i}': unknown key '{key}' (typo?)")
    for key in doc:
        if key not in KNOWN_TOP_KEYS:
            warnings.append(f"unknown top-level key '{key}' (typo?)")
    return errors, warnings


def infer_type(value: Any) -> str:
    if isinstance(value, bool):
        return "xs:boolean"
    if isinstance(value, int):
        return "xs:int"
    if isinstance(value, float):
        return "xs:double"
    return "xs:string"


# ─────────────────────────────────────────────────────────────────────────────
# Engine rules in MachineTool.aasx (ported from unified_cli.py)
# ─────────────────────────────────────────────────────────────────────────────

# The engine's StateChartExecutor only recognizes these keywords.
CONDITIONS = {">": "greater_than", "<": "less_than", "==": "equals", "out_of_bounds": "out_of_bounds"}
ENGINE_CONDITIONS = ["greater_than", "less_than", "equals", "out_of_bounds"]
RULE_PROPERTIES = ["targetSubmodel", "targetElement", "condition", "threshold", "action", "cooldownMs", "description"]
RULE_ID_RE = re.compile(r"^Rule_\d+$")
PROP_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


class AasxRules:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.RLock()

    def _xml(self) -> tuple[str, str]:
        if not self.path.is_file():
            raise HTTPException(404, f"AASX not found: {self.path}")
        with zipfile.ZipFile(self.path) as archive:
            name = next((n for n in archive.namelist() if n.endswith(".aas.xml")), None)
            if not name:
                raise HTTPException(422, "No .aas.xml found inside the AASX.")
            return archive.read(name).decode("utf-8"), name

    def _repack(self, xml: str, entry: str) -> None:
        tmp = self.path.with_name(self.path.name + ".tmp")
        try:
            with zipfile.ZipFile(self.path, "r") as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    norm = item.filename.replace("\\", "/")
                    zout.writestr(item, xml.encode("utf-8") if norm == entry else zin.read(item.filename))
            os.replace(tmp, self.path)
        except Exception as error:
            tmp.unlink(missing_ok=True)
            raise HTTPException(500, f"Repack failed: {error}") from error

    @staticmethod
    def _parse(xml: str) -> list[dict[str, str]]:
        rules = []
        for rule_id, block in re.findall(r"<idShort>(Rule_\d+)</idShort>(.*?)</submodelElementCollection>", xml, re.DOTALL):
            props: dict[str, str] = {}
            for prop in re.findall(r"<property>(.*?)</property>", block, re.DOTALL):
                id_m = re.search(r"<idShort>(.*?)</idShort>", prop, re.DOTALL)
                val_m = re.search(r"<value>(.*?)</value>", prop, re.DOTALL)
                if id_m and val_m:
                    props[id_m.group(1).strip()] = xml_unescape(val_m.group(1).strip())
            rules.append({"id": rule_id, **props})
        return rules

    def rules(self) -> list[dict[str, str]]:
        with self.lock:
            return self._parse(self._xml()[0])

    def info(self) -> dict[str, Any]:
        exists = self.path.is_file()
        return {"path": str(self.path), "exists": exists,
                "modified": datetime.fromtimestamp(self.path.stat().st_mtime).isoformat(timespec="seconds") if exists else None,
                "backups": [p.name for p in sorted(self.path.parent.glob(self.path.stem + "_backup_*.aasx"), reverse=True)] if exists else []}

    @staticmethod
    def _clean(rule: dict[str, Any], partial: bool = False) -> dict[str, str]:
        out: dict[str, str] = {}
        for key, value in rule.items():
            if key == "id":
                continue
            if not PROP_NAME_RE.fullmatch(str(key)):
                raise HTTPException(400, f"Invalid property name '{key}'")
            if value is None:
                continue
            text = str(value).strip()
            if key == "condition":
                text = CONDITIONS.get(text, text)
                if text not in ENGINE_CONDITIONS:
                    raise HTTPException(400, f"condition must be one of {ENGINE_CONDITIONS}")
            out[key] = text
        if not partial:
            for key in ("targetElement", "condition", "threshold", "action"):
                if not out.get(key):
                    raise HTTPException(400, f"'{key}' is required")
        return out

    def add(self, rule: dict[str, Any]) -> dict[str, Any]:
        props = self._clean(rule)
        with self.lock:
            xml, entry = self._xml()
            existing = self._parse(xml)
            next_n = max((int(r["id"].split("_")[1]) for r in existing), default=0) + 1
            rule_id = f"Rule_{next_n}"
            ordered = [k for k in RULE_PROPERTIES if props.get(k)] + [k for k in props if k not in RULE_PROPERTIES and props[k]]
            body = "".join(f"\n<property>\n<idShort>{k}</idShort>\n<valueType>xs:string</valueType>\n<value>{xml_escape(props[k])}</value>\n</property>" for k in ordered)
            block = f"\n<submodelElementCollection>\n<idShort>{rule_id}</idShort>\n<value>{body}\n</value>\n</submodelElementCollection>"
            matches = list(re.finditer(r"<idShort>Rule_\d+</idShort>.*?</submodelElementCollection>", xml, re.DOTALL))
            if matches:
                pos = matches[-1].end()
            else:
                anchor = re.search(r"<idShort>Rules[-_]SM</idShort>.*?<submodelElements>", xml, re.DOTALL)
                if not anchor:
                    raise HTTPException(422, "Neither existing rules nor a Rules-SM submodel were found to anchor the new rule.")
                pos = anchor.end()
            self._repack(xml[:pos] + block + xml[pos:], entry)
        return {"id": rule_id, **props}

    def _block(self, xml: str, rule_id: str) -> tuple[int, int]:
        if not RULE_ID_RE.fullmatch(rule_id):
            raise HTTPException(400, "Rule IDs look like Rule_<n>")
        id_match = re.search(r"<idShort>" + re.escape(rule_id) + r"</idShort>", xml)
        if not id_match:
            raise HTTPException(404, f"Rule '{rule_id}' not found")
        start = xml.rfind("<submodelElementCollection>", 0, id_match.start())
        end = xml.find("</submodelElementCollection>", id_match.end())
        if start == -1 or end == -1:
            raise HTTPException(422, f"Could not locate the XML block of {rule_id}")
        return start, end + len("</submodelElementCollection>")

    def update(self, rule_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        props = self._clean(changes, partial=True)
        if not props:
            raise HTTPException(400, "Nothing to change")
        with self.lock:
            xml, entry = self._xml()
            start, end = self._block(xml, rule_id)
            block = xml[start:end]
            changed = []
            for key, value in props.items():
                pattern = re.compile(r"(<property>\s*<idShort>" + re.escape(key) + r"</idShort>.*?<value>)(.*?)(</value>)", re.DOTALL)
                match = pattern.search(block)
                if match:
                    old = xml_unescape(match.group(2).strip())
                    block = block[:match.start(2)] + xml_escape(value) + block[match.end(2):]
                else:
                    old = None
                    close = block.rfind("</value>")
                    if close == -1:
                        raise HTTPException(422, f"{rule_id} has no <value> list")
                    block = block[:close] + f"<property>\n<idShort>{key}</idShort>\n<valueType>xs:string</valueType>\n<value>{xml_escape(value)}</value>\n</property>\n" + block[close:]
                changed.append({"property": key, "old": old, "new": value})
            self._repack(xml[:start] + block + xml[end:], entry)
        return {"id": rule_id, "changed": changed}

    def delete(self, rule_id: str) -> dict[str, Any]:
        with self.lock:
            xml, entry = self._xml()
            start, end = self._block(xml, rule_id)
            self._repack(xml[:start] + xml[end:], entry)
        return {"id": rule_id, "deleted": True}

    def verify(self) -> dict[str, Any]:
        rules = self.rules()
        problems = []
        for rule in rules:
            for key in ("targetElement", "condition", "threshold", "action"):
                if not rule.get(key):
                    problems.append(f"{rule['id']}: '{key}' is empty")
            if rule.get("condition") and rule["condition"] not in ENGINE_CONDITIONS:
                problems.append(f"{rule['id']}: condition '{rule['condition']}' is not evaluated by the engine")
        return {"readable": True, "count": len(rules), "rules": rules, "problems": problems}

    def backup(self) -> dict[str, Any]:
        if not self.path.is_file():
            raise HTTPException(404, f"AASX not found: {self.path}")
        dest = self.path.with_name(f"{self.path.stem}_backup_{datetime.now():%Y%m%d_%H%M%S}.aasx")
        shutil.copy2(self.path, dest)
        return {"backup": dest.name, "path": str(dest)}


def eval_condition(value: str, condition: str, threshold: str) -> bool:
    try:
        if condition == "out_of_bounds":
            low, high = [float(x) for x in threshold.split(",")[:2]]
            v = float(value)
            return v < low or v > high
        v, t = float(value), float(threshold)
        return {"greater_than": v > t, "less_than": v < t, "equals": v == t}.get(condition, False)
    except ValueError:
        return condition == "equals" and value == threshold


# ─────────────────────────────────────────────────────────────────────────────
# HTTP helpers
# ─────────────────────────────────────────────────────────────────────────────

def http(url: str, method: str = "GET", body: Any = None, *, raw: bytes | None = None,
         content_type: str = "application/json", timeout: float = 10.0) -> tuple[int, Any]:
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode("utf-8"))
    headers = {"Content-Type": content_type} if data is not None else {}
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            payload = response.read().decode("utf-8", errors="replace")
            status = response.status
    except urllib.error.HTTPError as error:
        payload, status = error.read().decode("utf-8", errors="replace"), error.code
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise HTTPException(502, f"Not reachable: {url} ({getattr(error, 'reason', error)})") from error
    try:
        return status, json.loads(payload) if payload else None
    except json.JSONDecodeError:
        return status, payload


def http_ok(url: str, method: str = "GET", body: Any = None, **kwargs) -> Any:
    status, payload = http(url, method, body, **kwargs)
    if status >= 400:
        detail = payload.get("message") or payload.get("error") or payload if isinstance(payload, dict) else payload
        raise HTTPException(status, detail or f"HTTP {status} from {url}")
    return payload


def reachable(url: str, timeout: float = 1.2) -> bool:
    try:
        urllib.request.urlopen(url, timeout=timeout).close()
        return True
    except urllib.error.HTTPError:
        return True  # the server answered, it is up
    except Exception:
        return False


def port_of(url: str, default: int) -> int:
    return urllib.parse.urlparse(url).port or default


# ─────────────────────────────────────────────────────────────────────────────
# Toolchain
# ─────────────────────────────────────────────────────────────────────────────

def find_java_home() -> str | None:
    java = "java.exe" if IS_WINDOWS else "java"
    configured = os.getenv("JAVA_HOME")
    if configured and (Path(configured) / "bin" / java).exists():
        return configured
    candidates = sorted((Path.home() / "Tools").glob(f"jdk-*/bin/{java}"), reverse=True)
    if candidates:
        return str(candidates[0].parents[1])
    found = shutil.which(java)
    return str(Path(found).resolve().parents[1]) if found else None


def wrap_script(path: str) -> list[str]:
    """Batch files need cmd.exe on Windows; a wrapper without exec bit needs sh."""
    if IS_WINDOWS and path.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", path]
    if not IS_WINDOWS and Path(path).name == "mvnw" and not os.access(path, os.X_OK):
        return ["sh", path]
    return [path]


def find_maven(project: Path, extra_dirs: list[Path] = ()) -> list[str] | None:
    configured = os.getenv("MAVEN_CMD")
    if configured:
        return wrap_script(configured)
    wrapper = project / ("mvnw.cmd" if IS_WINDOWS else "mvnw")
    if wrapper.is_file():
        return wrap_script(str(wrapper))
    name = "mvn.cmd" if IS_WINDOWS else "mvn"
    for base in [project, *extra_dirs]:
        bundled = base / "apache-maven-3.9.16" / "bin" / name
        if bundled.is_file():
            return wrap_script(str(bundled))
    tools = sorted((Path.home() / "Tools").glob(f"apache-maven-*/bin/{name}"), reverse=True)
    if tools:
        return wrap_script(str(tools[0]))
    found = shutil.which(name) or shutil.which("mvn")
    if found:
        return wrap_script(found)
    for base in extra_dirs:
        sibling = base / ("mvnw.cmd" if IS_WINDOWS else "mvnw")
        if sibling.is_file():
            return wrap_script(str(sibling))
    return None


_java_version_cache: dict[str, str] = {}


def java_version(java_home: str | None) -> str | None:
    if not java_home:
        return None
    if java_home not in _java_version_cache:
        java = Path(java_home) / "bin" / ("java.exe" if IS_WINDOWS else "java")
        try:
            out = subprocess.run([str(java), "-version"], capture_output=True, text=True, timeout=10)
            lines = [l.strip() for l in (out.stderr + out.stdout).splitlines() if l.strip() and not l.startswith("Picked up")]
            _java_version_cache[java_home] = lines[0] if lines else "unknown"
        except Exception as error:
            _java_version_cache[java_home] = f"unknown ({error})"
    return _java_version_cache[java_home]


def pids_on_port(port: int) -> list[int]:
    pids: set[int] = set()
    try:
        if IS_WINDOWS:
            out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, timeout=10).stdout
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 5 and parts[3].upper() == "LISTENING" and parts[1].rsplit(":", 1)[-1] == str(port):
                    pids.add(int(parts[4]))
        elif shutil.which("lsof"):
            out = subprocess.run(["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"], capture_output=True, text=True, timeout=10).stdout
            pids.update(int(x) for x in out.split() if x.isdigit())
        elif shutil.which("fuser"):
            out = subprocess.run(["fuser", f"{port}/tcp"], capture_output=True, text=True, timeout=10)
            pids.update(int(x) for x in (out.stdout + " " + out.stderr).split() if x.isdigit())
    except Exception:
        pass
    pids.discard(0)
    pids.discard(os.getpid())
    return sorted(pids)


def kill_tree(pid: int, *, force: bool = False) -> None:
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=20)
        return
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL if force else signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
        except OSError:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Component processes
# ─────────────────────────────────────────────────────────────────────────────

class Component:
    """One Maven project: optional build, then spring-boot:run, supervised in a thread."""

    def __init__(self, key: str, label: str, project: Path, base_url: str, health_paths: list[str],
                 build_args: list[str], run_args: list[str], run_subdir: str, log_dir: Path, state_dir: Path,
                 env: Callable[[], dict[str, str]] = dict, maven_dirs: list[Path] = ()):
        self.key, self.label, self.project = key, label, Path(project)
        self.base_url, self.health_paths = base_url.rstrip("/"), health_paths
        self.port = port_of(base_url, 0)
        self.build_args, self.run_args, self.run_subdir = build_args, run_args, run_subdir
        self.log_file = log_dir / f"{key}.log"
        self.marker = state_dir / f"{key}.built"
        self.extra_env, self.maven_dirs = env, list(maven_dirs)
        self.before_start: Callable[[], Any] | None = None  # e.g. write the installed plugins into the project
        self.lock = threading.RLock()
        self.proc: subprocess.Popen | None = None
        self.thread: threading.Thread | None = None
        self.phase = "stopped"
        self.message = ""
        self.started_at: float | None = None
        self.exit_code: int | None = None
        self.cancel = threading.Event()

    # -- helpers ------------------------------------------------------------
    def maven(self) -> list[str] | None:
        return find_maven(self.project, self.maven_dirs)

    def current_run_args(self) -> list[str]:
        return self.run_args() if callable(self.run_args) else list(self.run_args)

    def health(self) -> bool:
        return any(reachable(self.base_url + path) for path in self.health_paths[:1]) or \
            any(reachable(self.base_url + path) for path in self.health_paths[1:])

    def alive(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def _log(self, text: str) -> None:
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        with self.log_file.open("a", encoding="utf-8", errors="replace") as handle:
            handle.write(f"\n=== {datetime.now():%Y-%m-%d %H:%M:%S} {text} ===\n")

    def environment(self) -> dict[str, str]:
        env = os.environ.copy()
        java_home = find_java_home()
        if java_home:
            env["JAVA_HOME"] = java_home
            env["PATH"] = str(Path(java_home) / "bin") + os.pathsep + env.get("PATH", "")
        env.update(self.extra_env())
        return env

    def _spawn(self, args: list[str], cwd: Path) -> subprocess.Popen:
        handle = self.log_file.open("a", encoding="utf-8", errors="replace")
        handle.write("$ " + " ".join(args) + f"   (in {cwd})\n")
        handle.flush()
        kwargs: dict[str, Any] = {}
        if IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        else:
            kwargs["start_new_session"] = True
        try:
            return subprocess.Popen(args, cwd=str(cwd), stdout=handle, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, env=self.environment(), **kwargs)
        finally:
            handle.close()

    # -- lifecycle ----------------------------------------------------------
    def status(self) -> dict[str, Any]:
        healthy = self.health()
        with self.lock:
            tracked = self.alive()
            phase = self.phase
            if tracked and phase == "starting" and healthy:
                phase = self.phase = "running"
                self.message = f"Reachable on {self.base_url}"
            if tracked and phase == "running" and not healthy:
                phase = "starting"
            external = healthy and not tracked
            if external:
                phase = "external"
            maven = self.maven()
            return {
                "key": self.key, "label": self.label, "url": self.base_url, "port": self.port,
                "phase": phase, "running": healthy or tracked, "healthy": healthy, "tracked": tracked, "external": external,
                "pid": self.proc.pid if tracked and self.proc else None,
                "since": datetime.fromtimestamp(self.started_at).isoformat(timespec="seconds") if tracked and self.started_at else None,
                "message": self.message, "exitCode": self.exit_code,
                "project": str(self.project), "projectFound": self.project.is_dir(),
                "built": self.marker.exists(), "maven": " ".join(maven) if maven else None,
                "commands": {"build": " ".join((maven or ["mvn"]) + self.build_args),
                             "run": " ".join((maven or ["mvn"]) + self.current_run_args()) + (f"   (in {self.run_subdir})" if self.run_subdir else "")},
                "logFile": str(self.log_file),
            }

    def start(self, build: bool | None = None) -> dict[str, Any]:
        with self.lock:
            if self.alive():
                return {**self.status(), "message": f"{self.label} is already started by this UI."}
            if self.health():
                return {**self.status(), "message": f"{self.label} already answers on {self.base_url} (started outside this UI)."}
            if not self.project.is_dir():
                raise HTTPException(404, f"{self.label} project folder not found: {self.project}. "
                                         f"Put it next to the UI folder or set LABRADT_{self.key.upper()}_DIR.")
            maven = self.maven()
            if not maven:
                raise HTTPException(500, "Maven was not found. Install Maven, add it to PATH or set MAVEN_CMD.")
            build = (not self.marker.exists()) if build is None else bool(build)
            if self.before_start:
                try:
                    result = self.before_start()
                    self._log(f"Prepared the project: {result}")
                except Exception as error:  # a locked JAR must not prevent the start
                    self._log(f"Could not prepare the project: {error}")
            self.cancel.clear()
            self.exit_code = None
            self.started_at = time.time()
            self.phase = "building" if build else "starting"
            self.message = "Building with Maven …" if build else "Starting Spring Boot …"
            self._log(f"{self.label} start requested from UI (build={build})")
            self.thread = threading.Thread(target=self._run, args=(maven, build), name=f"stack-{self.key}", daemon=True)
            self.thread.start()
        time.sleep(0.3)
        return {**self.status(), "message": self.message}

    def _run(self, maven: list[str], build: bool) -> None:
        try:
            if build:
                proc = self._spawn(maven + self.build_args, self.project)
                with self.lock:
                    self.proc = proc
                code = proc.wait()
                if self.cancel.is_set():
                    return self._finish("stopped", "Build stopped.")
                if code != 0:
                    self.exit_code = code
                    return self._finish("failed", f"Build failed (exit {code}) - see log.")
                self.marker.parent.mkdir(parents=True, exist_ok=True)
                self.marker.write_text(datetime.now().isoformat(), encoding="utf-8")
                with self.lock:
                    self.phase, self.message = "starting", "Build OK · starting Spring Boot …"
            cwd = self.project / self.run_subdir if self.run_subdir else self.project
            proc = self._spawn(maven + self.current_run_args(), cwd)
            with self.lock:
                self.proc = proc
            code = proc.wait()
            self.exit_code = code
            if self.cancel.is_set():
                return self._finish("stopped", "Stopped.")
            self._finish("failed" if code else "stopped", f"Process ended (exit {code}) - see log." if code else "Process ended.")
        except Exception as error:  # never let the supervisor thread die silently
            self._finish("failed", f"Could not run Maven: {error}")

    def _finish(self, phase: str, message: str) -> None:
        with self.lock:
            self.phase, self.message = phase, message
        self._log(f"{self.label}: {message}")

    def stop(self) -> dict[str, Any]:
        with self.lock:
            proc, tracked = self.proc, self.alive()
            if not tracked:
                if self.health():
                    return {**self.status(), "message": f"{self.label} was not started by this UI. Use 'Force stop' to stop the process on port {self.port}."}
                return {**self.status(), "message": f"{self.label} is not running."}
            self.cancel.set()
            self.phase, self.message = "stopping", "Stopping …"
        if proc and proc.poll() is None:
            kill_tree(proc.pid)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                kill_tree(proc.pid, force=True)
        if self.thread:
            self.thread.join(timeout=10)
        # spring-boot:run forks a JVM; make sure nothing keeps the port.
        deadline = time.time() + 8
        while self.health() and time.time() < deadline:
            time.sleep(0.5)
        with self.lock:
            self.phase, self.message = "stopped", "Stopped."
        return {**self.status(), "message": f"{self.label} stopped."}

    def force_stop(self) -> dict[str, Any]:
        if self.alive():
            return self.stop()
        pids = pids_on_port(self.port)
        if not pids:
            return {**self.status(), "message": f"No process listens on port {self.port}."}
        for pid in pids:
            kill_tree(pid)
        time.sleep(1.5)
        for pid in pids_on_port(self.port):
            kill_tree(pid, force=True)
        self._log(f"Force stop of PIDs {pids} on port {self.port}")
        return {**self.status(), "message": f"Stopped PID {', '.join(map(str, pids))} on port {self.port}."}

    def logs(self, lines: int) -> str:
        if not self.log_file.exists():
            return f"No log yet ({self.log_file})."
        with self.log_file.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 768 * 1024))
            text = handle.read().decode("utf-8", errors="replace")
        return "\n".join(text.splitlines()[-max(1, min(lines, 4000)):])


# ─────────────────────────────────────────────────────────────────────────────
# The stack
# ─────────────────────────────────────────────────────────────────────────────

START_ORDER = ["runtime", "gateway", "engine"]

PROJECT_LABELS = {"engine": "Engine", "gateway": "Gateway", "runtime": "Runtime"}
PROJECT_HINTS = {"engine": "pom.xml of dt-engine with the rules AASX in src/main/resources",
                 "gateway": "pom.xml with the module dt-gateway-app", "runtime": "pom.xml with the module service-manager-app"}
PLUGIN_MARKER = ".labradt-plugin.json"


def detect_project(folder: Path) -> str | None:
    """Which LABraDT component project a folder holds: engine, gateway, runtime or None."""
    try:
        folder = Path(folder)
        if not (folder / "pom.xml").is_file():
            return None
        if (folder / "dt-gateway-app" / "pom.xml").is_file():
            return "gateway"
        if (folder / "service-manager-app" / "pom.xml").is_file():
            return "runtime"
        pom = (folder / "pom.xml").read_text(encoding="utf-8", errors="replace")
        resources = folder / "src" / "main" / "resources"
        if re.search(r"<artifactId>\s*dt-engine\s*</artifactId>", pom) or (resources.is_dir() and any(resources.glob("*.aasx"))):
            return "engine"
    except OSError:
        return None
    return None



class Stack:
    def __init__(self, *, engine_dir: Path, gateway_dir: Path, runtime_dir: Path, engine_url: str, gateway_health_url: str,
                 services_url: str, gateway_config_dir: Path, aasx_path: Path, state_dir: Path,
                 browse_opcua: Callable[..., list[dict]] | None = None, plugin_projects_dir: Path | None = None,
                 opcua_client: Callable[[dict], Any] | None = None):
        self.engine_dir, self.gateway_dir, self.runtime_dir = Path(engine_dir), Path(gateway_dir), Path(runtime_dir)
        self.engine_url = engine_url.rstrip("/")
        self.gateway_url = gateway_health_url.split("/api/", 1)[0].rstrip("/")
        self.services_url = services_url.rstrip("/")
        self.config_dir = Path(gateway_config_dir)
        self.aasx = AasxRules(aasx_path)
        self.state_dir = Path(state_dir)
        self.log_dir = self.state_dir / "logs"
        self.browse_opcua = browse_opcua
        self.opcua_client = opcua_client
        self.credentials: dict[str, str] = {}  # memory only, never written to disk
        self.job: dict[str, Any] = {"state": "idle"}
        self.job_lock = threading.Lock()
        extra_mvn = os.getenv("LABRADT_MAVEN_ARGS", "").split()
        self.extra_mvn = extra_mvn
        common = dict(log_dir=self.log_dir, state_dir=self.state_dir / "stack", maven_dirs=[self.gateway_dir, self.runtime_dir, self.engine_dir])
        self.components: dict[str, Component] = {
            "runtime": Component("runtime", "Runtime · Service Manager", self.runtime_dir, self.services_url,
                                 ["/actuator/health", "/registry/services"], extra_mvn + ["-DskipTests", "install"],
                                 self.runtime_run_args, "service-manager-app", env=self.runtime_env, **common),
            "gateway": Component("gateway", "Gateway", self.gateway_dir, self.gateway_url, ["/api/submodel/health"],
                                 extra_mvn + ["-DskipTests", "install"], self.gateway_run_args, "",
                                 env=self.gateway_env, **common),
            "engine": Component("engine", "Engine", self.engine_dir, self.engine_url, ["/engine/health", "/engine/state"],
                                extra_mvn + ["-DskipTests", "install"], extra_mvn + ["spring-boot:run"], "", **common),
        }

        self.plugins = GatewayPluginProjects(self, plugin_projects_dir or Path.home(), self.state_dir / "gateway-plugins")
        self.explorer = Explorer(self)
        self.runtime_plugins = RuntimePluginProjects(self, plugin_projects_dir or Path.home(), self.state_dir / "runtime-plugins")
        self.packager = ServicePackager(self)
        self.components["gateway"].before_start = lambda: self.apply_plugins("gateway")
        self.components["runtime"].before_start = lambda: self.apply_plugins("runtime")
        self.project_listeners: list[Callable[["Stack"], None]] = []  # other modules that keep project paths
        self.apply_hooks: dict[str, Callable[[], Any]] = {}
        self.services_listener: Callable[[list], None] | None = None  # keeps a snapshot of the registry
        self.catalog: Any = None  # project_model.ServiceCatalog, set by app.py
        self.rules_page_references: Callable[[str], list] | None = None

    def runtime_run_args(self) -> list[str]:
        # Plugins come from the project's plugins/ folder (PluginLauncher), written by apply_plugins before the start.
        return self.extra_mvn + ["spring-boot:run"]

    def runtime_env(self) -> dict[str, str]:
        # Blank canvas: no demo services are seeded when the Lua plugin is present (runtime.seed.enabled).
        return {"RUNTIME_SEED_ENABLED": os.getenv("RUNTIME_SEED_ENABLED", "false")}

    # -- gateway process ------------------------------------------------------
    def gateway_run_args(self) -> list[str]:
        # Protocol plugins come from the project's plugins/ folder (PluginLauncher), written by apply_plugins.
        return self.extra_mvn + ["-pl", "dt-gateway-app", "spring-boot:run"]

    def gateway_env(self) -> dict[str, str]:
        # Spring relaxed binding: DT_FRAMEWORK_CONFIGPATH -> dt.framework.config-path. The Gateway then
        # reads the machine configs straight from the project folder; no rebuild is needed after a change.
        env = {"DT_FRAMEWORK_CONFIGPATH": "file:" + self.config_dir.resolve().as_posix() + "/"}
        env.update(self.plugins.switches())
        env.update(self.credentials)
        return env

    # -- project folders (System page) ------------------------------------------
    def project_dir(self, key: str) -> Path:
        return {"engine": self.engine_dir, "gateway": self.gateway_dir, "runtime": self.runtime_dir}[key]

    def projects_info(self) -> dict[str, Any]:
        info = {}
        for key in START_ORDER:
            folder = self.project_dir(key)
            plugins = folder / "plugins"
            info[key] = {"path": str(folder), "found": folder.is_dir(), "kind": detect_project(folder),
                         "plugins": sorted(c.name for c in plugins.iterdir() if c.is_dir()) if plugins.is_dir() else []}
        info["gateway"]["configDir"] = str(self.config_dir)
        info["engine"]["aasx"] = str(self.aasx.path)
        return info

    def list_project_dirs(self, path: str | None) -> dict[str, Any]:
        listing = self.plugins.list_dirs(path, describe=False)
        for entry in listing["dirs"]:
            entry["project"] = detect_project(Path(entry["path"])) if listing["path"] else None
        listing["project"] = detect_project(Path(listing["path"])) if listing["path"] else None
        return listing

    def set_projects(self, changes: dict[str, Any]) -> dict[str, Any]:
        updates: dict[str, Path] = {}
        for key, value in (changes or {}).items():
            if key not in START_ORDER or not str(value or "").strip():
                continue
            folder = Path(str(value).strip().strip('"')).expanduser()
            if not folder.is_dir():
                raise HTTPException(404, f"Folder not found: {folder}")
            folder = folder.resolve()
            kind = detect_project(folder)
            if kind != key:
                raise HTTPException(422, f"{folder} is not a{'n' if key == 'engine' else ''} {PROJECT_LABELS[key]} project "
                                         f"({PROJECT_HINTS[key]})" + (f"; it looks like the {PROJECT_LABELS[kind]} project." if kind else "."))
            if folder != self.project_dir(key):
                comp = self.components[key]
                if comp.alive() or comp.health():
                    raise HTTPException(409, f"Stop the {comp.label} before changing its project folder.")
                updates[key] = folder
        for key, folder in updates.items():
            setattr(self, f"{key}_dir", folder)
            comp = self.components[key]
            comp.project = folder
            comp.marker.unlink(missing_ok=True)  # another project: build it at its first start
            if key == "gateway" and not os.getenv("GATEWAY_CONFIG_DIR"):
                self.config_dir = folder / "dt-gateway-app" / "src" / "main" / "resources" / "configs"
            if key == "engine" and not os.getenv("LABRADT_AASX_PATH"):
                resources = folder / "src" / "main" / "resources"
                found = [resources / "MachineTool.aasx"] if (resources / "MachineTool.aasx").is_file() else sorted(resources.glob("*.aasx"))
                self.aasx = AasxRules(found[0] if found else resources / "MachineTool.aasx")
        for comp in self.components.values():
            comp.maven_dirs = [self.gateway_dir, self.runtime_dir, self.engine_dir]
        if updates:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            (self.state_dir / "projects.json").write_text(json.dumps({k: str(self.project_dir(k)) for k in START_ORDER}, indent=2), encoding="utf-8")
            for listener in self.project_listeners:
                listener(self)
        return {"changed": sorted(updates), "projects": self.projects_info()}

    # -- hand-over into the projects ---------------------------------------------
    def apply_plugins(self, which: str) -> dict[str, Any]:
        """Writes the installed plugins into <project>/plugins/<key>/ (JARs + marker), removes plugin folders this UI
        wrote for plugins that are no longer installed, and writes plugins/labradt-plugins.properties (switches).
        The project then loads them on its own (PluginLauncher), with or without this UI."""
        store = self.plugins if which == "gateway" else self.runtime_plugins
        project = store.host_dir()
        if not project.is_dir():
            return {"project": str(project), "skipped": "project folder not found"}
        target = project / "plugins"
        installed = store.installed()
        written, removed, problems = [], [], []
        if installed:
            target.mkdir(parents=True, exist_ok=True)
        for plugin in installed:
            source, dest = store.store / plugin["key"] / "lib", target / plugin["key"]
            if dest.is_dir() and not (dest / PLUGIN_MARKER).is_file() and any(dest.iterdir()):
                problems.append(f"{dest} exists and was not written by the UI; left unchanged")
                continue
            try:
                dest.mkdir(parents=True, exist_ok=True)
                wanted = {name for name in plugin.get("jars", []) if (source / name).is_file()}
                for old in dest.glob("*.jar"):
                    if old.name not in wanted:
                        old.unlink()
                for name in sorted(wanted):
                    src, out = source / name, dest / name
                    if not out.is_file() or out.stat().st_size != src.stat().st_size or int(out.stat().st_mtime) != int(src.stat().st_mtime):
                        shutil.copy2(src, out)
                (dest / PLUGIN_MARKER).write_text(json.dumps({k: plugin.get(k) for k in ("id", "name", "protocol", "adapter", "category", "version", "installedAtText", "source")}, indent=2), encoding="utf-8")
                written.append(plugin["key"])
            except OSError as error:  # e.g. a JAR still open by a running JVM on Windows
                problems.append(f"{plugin['key']}: {error}")
        keep = {p["key"] for p in installed}
        if target.is_dir():
            for child in target.iterdir():
                if child.is_dir() and child.name not in keep and (child / PLUGIN_MARKER).is_file():
                    try:
                        shutil.rmtree(child)
                        removed.append(child.name)
                    except OSError as error:
                        problems.append(f"{child.name}: {error}")
        properties = target / "labradt-plugins.properties"
        switches = store.switches()
        if switches:
            lines = ["# Written by the LABraDT UI: enables the protocol adapters of the plugins in this folder."]
            lines += [f"{name.lower().replace('_', '.')}={value}" for name, value in sorted(switches.items())]
            properties.write_text("\n".join(lines) + "\n", encoding="utf-8")
        elif properties.is_file():
            properties.unlink()
        return {"project": str(project), "folder": str(target), "plugins": written, "removed": removed, "problems": problems}

    def apply_all(self) -> dict[str, Any]:
        result = {"gateway": self.apply_plugins("gateway"), "runtime": self.apply_plugins("runtime")}
        for name, hook in self.apply_hooks.items():  # e.g. AAS of an imported project waiting for the repository
            try:
                result[name] = hook()
            except Exception as error:
                result[name] = {"problems": [str(error)]}
        return result

    def component(self, key: str) -> Component:
        if key not in self.components:
            raise HTTPException(404, f"Unknown component '{key}'. Use one of {START_ORDER}.")
        return self.components[key]

    def engine_runtime_state(self) -> str | None:
        try:
            status, payload = http(self.engine_url + "/engine/runtime", timeout=2)
            return payload.get("state") if status < 400 and isinstance(payload, dict) else None
        except HTTPException:
            return None

    def require_config_unlocked(self) -> None:
        """Same business rule as the Backend environment: no configuration change while running."""
        if self.engine_runtime_state() == "RUNNING":
            raise HTTPException(409, "Automatic execution is running. Stop it (top bar · Stop Backend) before changing configuration.")

    def overview(self) -> dict[str, Any]:
        java_home = find_java_home()
        return {
            "projects": {"engine": str(self.engine_dir), "gateway": str(self.gateway_dir), "runtime": str(self.runtime_dir)},
            "projectInfo": self.projects_info(),
            "toolchain": {"javaHome": java_home, "java": java_version(java_home), "mavenArgs": os.getenv("LABRADT_MAVEN_ARGS", "")},
            "gatewayConfigDir": str(self.config_dir), "gatewayConfigDirFound": self.config_dir.is_dir(),
            "aasx": self.aasx.info(),
            "components": {key: self.components[key].status() for key in START_ORDER},
            "engineRuntime": self.engine_runtime_state(),
            "job": dict(self.job),
        }

    # -- whole stack ---------------------------------------------------------
    def _start_job(self, action: str, target: Callable[[], None]) -> dict[str, Any]:
        with self.job_lock:
            if self.job.get("state") == "running":
                raise HTTPException(409, f"'{self.job.get('action')}' is still in progress.")
            self.job = {"action": action, "state": "running", "step": "", "message": "", "startedAt": datetime.now().isoformat(timespec="seconds")}
        threading.Thread(target=target, name=f"stack-{action}", daemon=True).start()
        return dict(self.job)

    def start_all(self, build: bool | None) -> dict[str, Any]:
        timeout = float(os.getenv("LABRADT_START_TIMEOUT", "420"))

        def run() -> None:
            try:
                for key in START_ORDER:
                    comp = self.components[key]
                    self.job.update(step=key, message=f"Starting {comp.label} …")
                    if comp.health():
                        continue
                    comp.start(build)
                    deadline = time.time() + timeout
                    while time.time() < deadline:
                        status = comp.status()
                        if status["healthy"]:
                            break
                        if status["phase"] in ("failed", "stopped"):
                            raise RuntimeError(f"{comp.label}: {status['message']}")
                        time.sleep(2)
                    else:
                        raise RuntimeError(f"{comp.label} did not answer on {comp.base_url} within {int(timeout)} s.")
                aas = self.apply_hooks.get("aas")
                if aas:  # AAS of the engine project into the repository, if it runs
                    try:
                        aas()
                    except Exception:
                        pass
                self.job.update(state="done", step="", message="Runtime, Gateway and Engine are running.")
            except Exception as error:
                self.job.update(state="failed", message=str(getattr(error, "detail", error)))
        return self._start_job("start", run)

    def stop_all(self) -> dict[str, Any]:
        def run() -> None:
            notes = []
            for key in reversed(START_ORDER):
                comp = self.components[key]
                self.job.update(step=key, message=f"Stopping {comp.label} …")
                result = comp.stop()
                if result.get("external"):
                    notes.append(f"{comp.label} runs outside this UI")
            self.job.update(state="done", step="", message="Stack stopped." + (" " + "; ".join(notes) + " (use Force stop)." if notes else ""))
        return self._start_job("stop", run)

    # -- gateway configs (integrator) ---------------------------------------
    def config_entries(self) -> list[dict[str, Any]]:
        out = []
        for disabled, directory in ((False, self.config_dir), (True, self.config_dir / ".disabled")):
            for path in sorted(directory.glob("*.json")):
                try:
                    doc = json.loads(path.read_text(encoding="utf-8"))
                    conn = doc.get("connection") or {}
                    out.append({"file": path.name, "enabled": not disabled, "machineId": doc.get("machineId"),
                                "machineType": doc.get("machineType"), "protocol": doc.get("protocol"),
                                "endpoint": conn.get("endpoint"), "mappings": len(doc.get("mappings") or []),
                                "placeholders": sorted(set(PLACEHOLDER_RE.findall(json.dumps(conn))))})
                except (OSError, ValueError) as error:
                    out.append({"file": path.name, "enabled": not disabled, "error": str(error)})
        return out

    def taken_ids(self, ignore: str | None = None) -> set[str]:
        return {e["machineId"] for e in self.config_entries() if e.get("machineId") and e["machineId"] != ignore}

    def validate(self, doc: Any, replace: bool = False) -> dict[str, Any]:
        mid = doc.get("machineId") if isinstance(doc, dict) else None
        errors, warnings = validate_config(doc, self.taken_ids(ignore=mid if replace else None))
        return {"valid": not errors, "errors": errors, "warnings": warnings}

    def install(self, doc: Any, *, force: bool = False, replace: bool = False) -> dict[str, Any]:
        self.require_config_unlocked()
        result = self.validate(doc, replace)
        if result["errors"]:
            raise HTTPException(422, {"message": "Config NOT installed - fix these errors.", **result})
        if result["warnings"] and not force:
            raise HTTPException(422, {"message": "Config has warnings. Confirm to install anyway.", "needsConfirmation": True, **result})
        if not self.config_dir.is_dir():
            if not self.gateway_dir.is_dir():
                raise HTTPException(404, f"Gateway project folder not found: {self.gateway_dir}")
            self.config_dir.mkdir(parents=True, exist_ok=True)
        out = self.config_dir / f"{doc['machineId']}.json"
        tmp = out.with_name(out.name + ".pending")
        tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(tmp, out)
        placeholders = sorted(set(PLACEHOLDER_RE.findall(json.dumps(doc.get("connection") or {}))))
        return {**result, "installed": out.name, "path": str(out), "machineId": doc["machineId"], "protocol": doc["protocol"],
                "endpoint": doc["connection"]["endpoint"], "elements": len(doc["mappings"]), "credentialVariables": placeholders,
                "restartRequired": self.components["gateway"].health()}

    def presets(self) -> list[dict[str, Any]]:
        resources = self.gateway_dir / "dt-gateway-app" / "src" / "main" / "resources"
        out = []
        for folder in sorted(resources.glob("configs-*")):
            for path in sorted(folder.glob("*.json")):
                try:
                    doc = json.loads(path.read_text(encoding="utf-8"))
                    out.append({"folder": folder.name, "file": path.name, "machineId": doc.get("machineId"),
                                "protocol": doc.get("protocol"), "endpoint": (doc.get("connection") or {}).get("endpoint")})
                except (OSError, ValueError):
                    continue
        return out

    def preset(self, folder: str, file: str) -> dict[str, Any]:
        if not re.fullmatch(r"configs-[A-Za-z0-9_-]+", folder) or not MACHINE_FILE_RE.fullmatch(file):
            raise HTTPException(400, "Invalid preset")
        path = self.gateway_dir / "dt-gateway-app" / "src" / "main" / "resources" / folder / file
        if not path.is_file():
            raise HTTPException(404, "Preset not found")
        return json.loads(path.read_text(encoding="utf-8"))

    def remove_config(self, file: str) -> dict[str, Any]:
        self.require_config_unlocked()
        if not MACHINE_FILE_RE.fullmatch(file):
            raise HTTPException(400, "Invalid file name")
        for path in (self.config_dir / file, self.config_dir / ".disabled" / file):
            if path.is_file():
                path.unlink()
                return {"removed": file}
        raise HTTPException(404, "Config not found")

    def credential_status(self) -> list[dict[str, Any]]:
        names: set[str] = set()
        for entry in self.config_entries():
            names.update(entry.get("placeholders") or [])
            if entry.get("machineId") and entry.get("placeholders"):
                names.update(credential_env_names(entry["machineId"]))
        return [{"name": n, "set": n in self.credentials or bool(os.environ.get(n)),
                 "source": "UI (memory)" if n in self.credentials else "environment" if os.environ.get(n) else None}
                for n in sorted(names)]

    def set_credential(self, name: str, value: str | None) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]{0,127}", name or ""):
            raise HTTPException(400, "Variable names look like DT_MACHINE_USERNAME")
        if value:
            self.credentials[name] = value
        else:
            self.credentials.pop(name, None)
        return {"name": name, "set": bool(value), "restartRequired": self.components["gateway"].health()}

    def browse(self, payload: dict[str, Any]) -> dict[str, Any]:
        protocol = str(payload.get("protocol", "OPC_UA")).upper()
        endpoint = str(payload.get("endpoint", "")).strip()
        username, password = payload.get("username") or "", payload.get("password") or ""
        lookup = lambda name: self.credentials.get(name) or os.environ.get(name) or ""
        for key, value in (("username", payload.get("usernameEnv")), ("password", payload.get("passwordEnv"))):
            if value and not (username if key == "username" else password):
                if key == "username": username = lookup(str(value))
                else: password = lookup(str(value))
        if not endpoint:
            raise HTTPException(400, "Endpoint is required")
        if protocol == "OPC_UA":
            if not endpoint.startswith("opc.tcp://"):
                raise HTTPException(400, "OPC UA endpoints start with opc.tcp://")
            if not self.browse_opcua:
                raise HTTPException(503, "OPC UA browsing is not available.")
            nodes = self.browse_opcua(endpoint, username or None, password or None)
            signals = [{"address": n.get("sourceAddress"), "name": n.get("name"), "valueType": n.get("valueType"),
                        "value": n.get("value"), "writable": n.get("writable")} for n in nodes]
        elif protocol == "MQTT":
            signals = browse_mqtt(endpoint, username, password, str(payload.get("topicFilter") or "#"),
                                  float(payload.get("listenSeconds") or 4))
        else:
            raise HTTPException(400, f"Browsing supports {CLI_PROTOCOLS}")
        return {"protocol": protocol, "endpoint": endpoint, "count": len(signals), "signals": signals}

    def create_from_browse(self, payload: dict[str, Any]) -> dict[str, Any]:
        """unified_cli._gw_browse: build a config from picked signals; credentials become placeholders."""
        machine_id = str(payload.get("machineId", "")).strip()
        protocol = str(payload.get("protocol", "OPC_UA")).upper()
        connection: dict[str, Any] = {"endpoint": str(payload.get("endpoint", "")).strip()}
        variables = None
        if payload.get("withCredentials"):
            user_var, pass_var = credential_env_names(machine_id)
            connection["username"], connection["password"] = "${" + user_var + "}", "${" + pass_var + "}"
            variables = [user_var, pass_var]
        if protocol == "MQTT":
            connection["quietWindowMs"] = 15000
            if payload.get("topicFilter") and payload["topicFilter"] != "#":
                connection["topicFilter"] = payload["topicFilter"]
        mappings = []
        for m in payload.get("mappings") or []:
            item = {"sourceAddress": m.get("sourceAddress"), "idShort": m.get("idShort"), "valueType": m.get("valueType") or "xs:string"}
            if m.get("unit"):
                item["unit"] = m["unit"]
            mappings.append(item)
        doc = {"machineId": machine_id, "machineType": payload.get("machineType") or "Generic", "protocol": protocol,
               "connection": connection, "mappings": mappings}
        result = self.install(doc, force=bool(payload.get("force")))
        return {**result, "credentialVariables": variables or [], "config": doc}

    # -- services (integrator + operator) ------------------------------------
    def svc(self, path: str, method: str = "GET", body: Any = None) -> Any:
        return http_ok(self.services_url + path, method, body)

    def upload_to_engine(self, filename: str, content_b64: str, key: str | None = None) -> str:
        """Multipart POST to engine storage, as unified_cli.svc_upload_file."""
        try:
            data = base64.b64decode(content_b64, validate=True)
        except Exception as error:
            raise HTTPException(400, "File content must be base64") from error
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(413, "Files up to 20 MiB")
        name = Path(filename or "upload.bin").name
        if not self.components["engine"].health():
            # The Engine is stopped: write the file straight into the engine project's storage (same key format).
            from .project_model import store_service_file
            return store_service_file(self.engine_dir, name, data, key)
        boundary = f"----LABraDTBoundary{int(time.time() * 1000)}"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
                f"Content-Type: application/octet-stream\r\n\r\n").encode() + data
        if key:
            body += f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\n{key}".encode()
        body += f"\r\n--{boundary}--\r\n".encode()
        payload = http_ok(self.engine_url + "/engine/storage/upload", "POST", raw=body,
                          content_type=f"multipart/form-data; boundary={boundary}", timeout=60)
        reference = payload.get("fileReference") if isinstance(payload, dict) else None
        if not reference:
            raise HTTPException(502, f"Engine storage returned no fileReference: {payload}")
        return reference

    def register_service(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.require_config_unlocked()
        adapters = {"LUA": "SCRIPT", "BASH": "SCRIPT", "DOCKER": "CONTAINER", "REST": "EXTERNAL"}
        service_id = str(payload.get("serviceId", "")).strip()
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", service_id):
            raise HTTPException(400, "A valid Service ID is required (letters, digits, _ . -)")
        category, adapter = payload.get("executionCategory"), payload.get("technologyAdapter")
        if category not in ("SCRIPT", "CONTAINER", "EXTERNAL") or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,40}", str(adapter or "")) \
                or (adapter in adapters and adapters[adapter] != category):
            raise HTTPException(400, "Runtime does not match the category (SCRIPT: LUA/BASH, CONTAINER: DOCKER, EXTERNAL: REST, or an adapter added by a runtime plugin)")
        args = payload.get("defaultArgs") or {}
        if not isinstance(args, dict):
            raise HTTPException(400, "defaultArgs must be an object")
        definition = {"serviceId": service_id, "displayName": payload.get("displayName") or "", "description": payload.get("description") or "",
                      "executionCategory": category, "technologyAdapter": adapter, "defaultArgs": {str(k): str(v) for k, v in args.items()}}
        upload = payload.get("file")
        if upload and category != "EXTERNAL":
            definition["fileReference"] = self.upload_to_engine(upload.get("name"), upload.get("content", ""), payload.get("storageKey"))
        elif payload.get("fileReference"):
            definition["fileReference"] = str(payload["fileReference"])
        if self.catalog is not None:  # live registry, or the runtime project while the Runtime is stopped
            if any(s.get("serviceId") == service_id for s in self.catalog.list()[0]):
                raise HTTPException(409, f"Service '{service_id}' already exists")
            saved = self.catalog.upsert(definition)
            return {"registered": service_id, "definition": definition, "where": saved["where"], "message": saved.get("message", "")}
        status, body = http(self.services_url + "/registry/services", "POST", definition)
        if status >= 400 or (isinstance(body, dict) and body.get("error")):
            raise HTTPException(status if status >= 400 else 422, (body.get("message") if isinstance(body, dict) else body) or "Registration failed")
        return {"registered": service_id, "definition": definition, "response": body}

    def coupled_rules(self, service_id: str) -> list[dict[str, Any]]:
        found = list(self.rules_page_references(service_id)) if self.rules_page_references else []
        try:
            for rule in self.aasx.rules():
                if service_id in [a.strip() for a in str(rule.get("action", "")).split(",")]:
                    found.append({"source": "AASX", **rule})
        except HTTPException:
            pass
        try:
            status, rules = http(self.engine_url + "/engine/rules", timeout=3)
            if status < 400 and isinstance(rules, list):
                known = {r["id"] for r in found}
                for rule in rules:
                    rid = rule.get("idShort") or rule.get("id")
                    if rid not in known and service_id in [a.strip() for a in str(rule.get("action", "")).split(",")]:
                        found.append({"source": "Engine", "id": rid, **rule})
        except HTTPException:
            pass
        return found

    def delete_service(self, service_id: str, force: bool) -> dict[str, Any]:
        self.require_config_unlocked()
        coupled = self.coupled_rules(service_id)
        if coupled and not force:
            raise HTTPException(409, {"message": f"'{service_id}' is referenced by {len(coupled)} rule(s). Deleting it leaves those rules pointing at a missing action.",
                                      "rules": coupled, "needsConfirmation": True})
        if self.catalog is not None:
            definition = next((d for d in self.catalog.list()[0] if d.get("serviceId") == service_id), None)
            self.catalog.delete(service_id)
        else:
            definition = None
            status, body = http(self.services_url + "/registry/services/" + urllib.parse.quote(service_id, safe=""))
            if status < 400 and isinstance(body, dict):
                definition = body
            status, body = http(self.services_url + "/registry/services/" + urllib.parse.quote(service_id, safe=""), "DELETE")
            if status >= 400:
                raise HTTPException(status, f"Delete failed (HTTP {status}): {body}")
        storage = None
        ref = (definition or {}).get("fileReference")
        if isinstance(ref, str) and ref.strip():
            local = self.engine_dir / "storage" / (ref.strip("/") + ".json")
            try:
                if self.components["engine"].health():
                    code, _ = http(self.engine_url + "/engine/storage/" + ref.lstrip("/"), "DELETE")
                    storage = "removed" if 200 <= code < 300 else "already gone" if code == 404 else f"HTTP {code}"
                elif local.is_file():
                    local.unlink()
                    storage = "removed from the engine project"
                else:
                    storage = "already gone"
            except (HTTPException, OSError) as error:
                storage = f"cleanup failed: {getattr(error, 'detail', error)}"
        return {"deleted": service_id, "storageFile": ref, "storage": storage, "coupledRules": coupled}

    # -- engine operator -----------------------------------------------------
    def engine_text(self, path: str) -> str:
        status, body = http(self.engine_url + path, timeout=15)
        if status >= 400:
            raise HTTPException(status, body if isinstance(body, str) else json.dumps(body))
        return body if isinstance(body, str) else json.dumps(body, indent=2)

    def push(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = {"submodelId": str(payload.get("submodelId") or "CPS_SM"), "elementId": str(payload.get("elementId", "")).strip(),
                "value": str(payload.get("value", "")).strip()}
        if not body["elementId"] or not body["value"]:
            raise HTTPException(400, "Element ID and value are required")
        try:
            rules = self.aasx.rules()
        except HTTPException:
            rules = []
        matching = [r for r in rules if r.get("targetElement") == body["elementId"]
                    and eval_condition(body["value"], r.get("condition", ""), r.get("threshold", ""))]
        status, response = http(self.engine_url + "/engine/push", "POST", body)
        return {"request": body, "status": status, "response": response, "matchingRules": matching}


def browse_mqtt(endpoint: str, username: str, password: str, topic_filter: str, listen_secs: float) -> list[dict[str, Any]]:
    try:
        import paho.mqtt.client as mqtt
    except ImportError as error:
        raise HTTPException(503, "MQTT browsing needs paho-mqtt:  pip install paho-mqtt") from error
    host = endpoint.replace("tcp://", "").replace("mqtt://", "").replace("ssl://", "")
    port = 1883
    if ":" in host:
        host, port_text = host.rsplit(":", 1)
        port = int(port_text)
    collected: dict[str, str] = {}

    def on_message(_client, _userdata, msg):
        collected[msg.topic] = msg.payload.decode(errors="replace")

    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="labradt-ui-browse")  # paho >= 2
    except AttributeError:
        client = mqtt.Client(client_id="labradt-ui-browse")
    if username:
        client.username_pw_set(username, password)
    client.on_message = on_message
    try:
        client.connect(host, port, keepalive=15)
    except Exception as error:
        raise HTTPException(502, f"Could not connect to {host}:{port}: {error}") from error
    client.subscribe(topic_filter, qos=1)
    client.loop_start()
    time.sleep(max(1.0, min(listen_secs, 20.0)))
    client.loop_stop()
    client.disconnect()
    signals = []
    for topic in sorted(collected):
        payload = collected[topic]
        value, dtype = payload, "xs:string"
        try:
            parsed = json.loads(payload)
            value = parsed["value"] if isinstance(parsed, dict) and "value" in parsed else parsed
            dtype = infer_type(value)
        except Exception:
            pass
        signals.append({"address": topic, "name": topic.rsplit("/", 1)[-1], "valueType": dtype, "value": str(value)[:80]})
    return signals


# ─────────────────────────────────────────────────────────────────────────────
# Gateway protocol plugins from gateway-implementations (Maven projects)
# ─────────────────────────────────────────────────────────────────────────────

AUTOCONFIG_IMPORTS = Path("src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports")
PLUGIN_PROTOCOL_HINTS = [("opcua", "OPC_UA"), ("opc-ua", "OPC_UA"), ("mqtt", "MQTT"), ("modbus", "MODBUS"), ("dds", "DDS"), ("profinet", "PROFINET")]
PLUGIN_SWITCHES = {"MQTT": "DT_ADAPTER_MQTT_ENABLED", "OPC_UA": "DT_ADAPTER_OPCUA_ENABLED"}
PLUGIN_NAMES = {"MQTT": "MQTT client", "OPC_UA": "OPC UA client"}
# Plugin projects written against the former core package build against the renamed core.
CORE_RENAMES = [("com.guc.dt_framework", "de.labradt.gateway.framework")]
CORE_POM_RE = re.compile(r"<groupId>\s*com\.guc\s*</groupId>(\s*)<artifactId>\s*dt-framework\s*</artifactId>")


class GatewayPluginProjects:
    """Builds a protocol plugin project (e.g. mqtt-plugin) and puts its JARs on the Gateway classpath.

    Nothing in the plugin project or the gateway project is changed: the plugin is built from a
    staged copy under runtime/gateway-plugins/<key>/, and the Gateway is started with
    spring-boot.run.additional-classpath-elements (the plugin's own JARs plus the dependencies the
    Gateway does not already have, e.g. Eclipse Paho).
    """

    COMPONENT, LABEL, HOST_MODULE, LOG_PREFIX = "gateway", "Gateway", "dt-gateway-app", "gateway-plugin"

    def __init__(self, stack: "Stack", root: Path, store: Path):
        self.stack, self.root, self.store = stack, Path(root), Path(store)
        self.job: dict[str, Any] = {"state": "idle"}
        self.lock = threading.Lock()

    def host_dir(self) -> Path:
        return self.stack.gateway_dir

    def adapt(self, path: Path, text: str) -> str:
        """Builds plugin projects written against the former core package against the renamed core."""
        for old, repl in CORE_RENAMES:
            text = text.replace(old, repl)
        if path.name == "pom.xml":
            text = CORE_POM_RE.sub(r"<groupId>de.labradt</groupId>\1<artifactId>dt-gateway-framework</artifactId>", text)
        return text

    # -- discovery -------------------------------------------------------------
    @staticmethod
    def protocol_of(name: str) -> str | None:
        lowered = name.lower()
        return next((protocol for hint, protocol in PLUGIN_PROTOCOL_HINTS if hint in lowered), None)

    def describe(self, folder: Path) -> dict[str, Any] | None:
        """Plugin project info for a folder, or None when it is not a Gateway protocol plugin project."""
        try:
            if not (folder / "pom.xml").is_file():
                return None
            modules = sorted(m.name for m in folder.iterdir() if m.is_dir() and (m / "pom.xml").is_file() and (m / AUTOCONFIG_IMPORTS).is_file())
        except OSError:
            return None
        if not modules:
            return None
        imports = " ".join((folder / m / AUTOCONFIG_IMPORTS).read_text(encoding="utf-8", errors="replace") for m in modules)
        protocol = self.protocol_of(folder.name) or self.protocol_of(imports) or self.protocol_of(" ".join(modules))
        if not protocol:
            return None
        summary = ""
        readme = folder / "README.md"
        if readme.is_file():
            paragraphs = [" ".join(l.strip() for l in block.splitlines()) for block in readme.read_text(encoding="utf-8", errors="replace").split("\n\n")]
            summary = next((t for t in paragraphs if t and not t.startswith(("#", "*", "|", "`", "<"))), "")
        installed = {p["key"] for p in self.installed()}
        key = re.sub(r"[^A-Za-z0-9._-]+", "-", folder.name).strip("-") or protocol.lower()
        return {"key": key, "id": "plugin:" + protocol, "protocol": protocol, "name": PLUGIN_NAMES.get(protocol, protocol),
                "projectName": folder.name, "modules": modules, "summary": summary, "installed": key in installed}

    def inspect(self, path: str) -> dict[str, Any]:
        folder = Path(str(path or "").strip().strip('"')).expanduser()
        if not str(path or "").strip() or not folder.is_dir():
            raise HTTPException(404, "Folder not found. Choose the plugin project folder (the one with the plugin's pom.xml).")
        info = self.describe(folder.resolve())
        if not info:
            raise HTTPException(422, "No Gateway protocol plugin project in this folder: it needs a pom.xml and modules with "
                                     "META-INF/spring/…AutoConfiguration.imports (e.g. mqtt-adapter, mqtt-translator).")
        return {**info, "path": str(folder.resolve())}

    START_ENV, START_SIBLING = "LABRADT_GATEWAY_PLUGINS_DIR", "gateway-implementations"

    def start_folder(self) -> str:
        """Where the plugin folder chooser opens: the env setting, else the plugin folder next to the project
        (e.g. OpenSource/gateway-implementations, OpenSource/runtime-plugins), else the home folder."""
        configured = os.getenv(self.START_ENV, "").strip()
        candidates = [Path(configured).expanduser()] if configured else []
        candidates.append(self.host_dir().parent / self.START_SIBLING)
        return next((str(c.resolve()) for c in candidates if c.is_dir()), str(Path.home()))

    @staticmethod
    def nearest_folder(path: str | None, fallback: str) -> str:
        """The folder a chooser opens for a typed value: the folder itself, the folder of a file, the closest
        existing parent of a path that does not exist (yet), else the fallback. Never fails on what was typed."""
        text = str(path or "").strip().strip('"')
        if not text:
            return fallback
        candidate = Path(text).expanduser()
        if not candidate.is_absolute():
            return fallback
        for folder in [candidate, *candidate.parents]:
            try:
                if folder.is_dir():
                    return str(folder)
            except OSError:
                continue
        return fallback

    def list_entries(self, path: str | None, accept: list[str]) -> dict[str, Any]:
        """Folders and files (filtered by extension) for the service File / Endpoint chooser."""
        if path:
            path = self.nearest_folder(path, str(Path.home()))
        listing = self.list_dirs(path, describe=False)
        if not listing["path"]:
            return {**listing, "entries": [{"type": "dir", **d} for d in listing["dirs"]]}
        folder = Path(listing["path"])
        markers = ("Dockerfile", "Containerfile", "main.py", "main.lua", "init.lua")
        entries = []
        for d in listing["dirs"]:
            try:
                found = [m for m in markers if (Path(d["path"]) / m).is_file()]
            except OSError:
                found = []
            entries.append({"type": "dir", "name": d["name"], "path": d["path"], "contains": found})
        try:
            files = sorted((f for f in folder.iterdir() if f.is_file() and not f.name.startswith(".")), key=lambda f: f.name.lower())
        except OSError:
            files = []
        wanted = [a.lower() for a in accept if a]
        for f in files[:500]:
            name = f.name.lower()
            if wanted and not any(name.endswith(a) or name == a.lstrip(".") or (a == "dockerfile" and "dockerfile" in name) for a in wanted):
                continue
            entries.append({"type": "file", "name": f.name, "path": str(f), "size": f.stat().st_size})
        found = [m for m in markers if (folder / m).is_file()]
        return {"path": listing["path"], "parent": listing["parent"], "entries": entries, "contains": found}

    def list_dirs(self, path: str | None, describe: bool = True) -> dict[str, Any]:
        """Sub-folders of a folder for the plugin folder chooser (names only, no files)."""
        if not path:
            if IS_WINDOWS:
                drives = [f"{letter}:\\" for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if Path(f"{letter}:\\").exists()]
                return {"path": "", "parent": None, "dirs": [{"name": d, "path": d, "plugin": None} for d in drives]}
            path = "/"
        folder = Path(path).expanduser()
        if not folder.is_dir():
            raise HTTPException(404, "Folder not found")
        folder = folder.resolve()
        dirs = []
        try:
            children = sorted((c for c in folder.iterdir() if c.is_dir() and not c.name.startswith((".", "$"))), key=lambda c: c.name.lower())
        except OSError as error:
            raise HTTPException(403, f"Cannot open this folder: {error}") from error
        for child in children[:400]:
            info = self.describe(child) if describe else None
            dirs.append({"name": child.name, "path": str(child), "plugin": info["protocol"] if info else None})
        parent = str(folder.parent) if folder.parent != folder else ("" if IS_WINDOWS else None)
        return {"path": str(folder), "parent": parent, "dirs": dirs, "plugin": (self.describe(folder) or {}).get("protocol") if describe else None}

    def installed(self) -> list[dict[str, Any]]:
        out = []
        for path in sorted(self.store.glob("*/plugin.json")):
            try:
                out.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        return out

    def jars(self) -> list[str]:
        return [str((self.store / p["key"] / "lib" / name).resolve()) for p in self.installed() for name in p.get("jars", [])
                if (self.store / p["key"] / "lib" / name).is_file()]

    def switches(self) -> dict[str, str]:
        return {PLUGIN_SWITCHES[p["protocol"]]: "true" for p in self.installed() if p.get("protocol") in PLUGIN_SWITCHES}

    def catalogue_entries(self) -> list[dict[str, Any]]:
        gateway = self.stack.components[self.COMPONENT]
        healthy, tracked = gateway.health(), gateway.alive()
        entries = []
        for p in self.installed():
            installed_at = p.get("installedAt", 0)
            if healthy and tracked and (gateway.started_at or 0) >= installed_at:
                status, message = "Loaded", "On the Gateway classpath since its last start."
            elif healthy:
                status, message = "Restart required", f"Restart the {self.LABEL} from the System page to load this plugin."
            else:
                status, message = "Installed", f"Loads when the {self.LABEL} starts."
            entries.append({"id": p["id"], "name": p["name"], "protocol": p["protocol"], "version": p.get("version", ""),
                            "source": "project", "key": p["key"], "status": status, "message": message,
                            "projectName": p.get("projectName") or p["key"], "jars": p.get("jars", []),
                            "adapter": p.get("adapter"), "category": p.get("category"), "kind": p.get("kind", "project"),
                            "technology": f"{p['category']}/{p['adapter']}" if p.get("category") and p.get("adapter") else None})
        return entries

    # -- install / uninstall ---------------------------------------------------
    def _run(self, args: list[str], cwd: Path, log: Path) -> int:
        with log.open("a", encoding="utf-8", errors="replace") as handle:
            handle.write(f"$ {' '.join(args)}   (in {cwd})\n")
            handle.flush()
            proc = subprocess.run(args, cwd=str(cwd), stdout=handle, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                  env=self.stack.components[self.COMPONENT].environment())
        return proc.returncode

    @staticmethod
    def _key(jar: Path) -> str:
        # .../repository/<group path>/<artifactId>/<version>/<file>.jar -> "<group-tail>/<artifactId>"
        return f"{jar.parent.parent.parent.name}/{jar.parent.parent.name}"

    def install(self, path: str) -> dict[str, Any]:
        project = self.inspect(path)
        key = project["key"]
        if any(p["protocol"] == project["protocol"] and p["key"] != key for p in self.installed()):
            raise HTTPException(409, f"A {project['protocol']} plugin is already installed. Uninstall it first.")
        self.stack.require_config_unlocked()
        with self.lock:
            if self.job.get("state") == "running":
                raise HTTPException(409, f"Installing {self.job.get('key')} is still in progress.")
            log = self.stack.log_dir / f"{self.LOG_PREFIX}-{key}.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text(f"=== {datetime.now():%Y-%m-%d %H:%M:%S} install {key} ===\n", encoding="utf-8")
            self.job = {"key": key, "protocol": project["protocol"], "state": "running", "step": "Preparing", "message": "", "log": str(log)}
        threading.Thread(target=self._install, args=(project, log), name=f"plugin-{key}", daemon=True).start()
        return dict(self.job)

    def _install(self, project: dict[str, Any], log: Path) -> None:
        def step(text: str) -> None:
            self.job.update(step=text)
            with log.open("a", encoding="utf-8") as handle:
                handle.write(f"\n--- {text}\n")
        try:
            gateway = self.stack.components[self.COMPONENT]
            maven = gateway.maven()
            if not maven:
                raise RuntimeError("Maven was not found. Install Maven, add it to PATH or set MAVEN_CMD.")
            if not self.host_dir().is_dir():
                raise RuntimeError(f"{self.LABEL} project folder not found: {self.host_dir()}")
            extra = self.stack.extra_mvn
            if not gateway.marker.exists():
                step(f"Installing the {self.LABEL} core into the local Maven repository")
                if self._run(maven + extra + ["-DskipTests", "install"], self.host_dir(), log):
                    raise RuntimeError(f"{self.LABEL} core build failed - see the plugin log.")
                gateway.marker.parent.mkdir(parents=True, exist_ok=True)
                gateway.marker.write_text(datetime.now().isoformat(), encoding="utf-8")

            step("Staging the plugin sources")
            home = self.store / project["key"]
            work = home / "build"
            shutil.rmtree(work, ignore_errors=True)
            shutil.copytree(project["path"], work, ignore=shutil.ignore_patterns("target", ".git", ".idea", "mocks", "*.log"))
            adapted = 0
            for path in list(work.rglob("*.java")) + list(work.rglob("pom.xml")) + list(work.rglob("*.imports")):
                text = path.read_text(encoding="utf-8")
                new = self.adapt(path, text)
                if new != text:
                    path.write_text(new, encoding="utf-8")
                    adapted += 1
            if adapted:
                with log.open("a", encoding="utf-8") as handle:
                    handle.write(f"Adapted {adapted} file(s) of the staged copy to the renamed {self.LABEL} core (de.labradt).\n")

            step("Building the plugin")
            if self._run(maven + extra + ["-DskipTests", "install"], work, log):
                raise RuntimeError("Plugin build failed - see the plugin log.")

            step("Resolving the plugin classpath")
            gateway_cp = home / "host-classpath.txt"
            if self._run(maven + extra + ["-q", "-pl", self.HOST_MODULE, "dependency:build-classpath", "-Dmdep.includeScope=runtime",
                                          f"-Dmdep.outputFile={gateway_cp}"], self.host_dir(), log):
                raise RuntimeError(f"Could not resolve the {self.LABEL} classpath - see the plugin log.")
            if self._run(maven + extra + ["-q", "dependency:build-classpath", "-Dmdep.includeScope=runtime",
                                          "-Dmdep.outputFile=target/labradt-classpath.txt"], work, log):
                raise RuntimeError("Could not resolve the plugin classpath - see the plugin log.")
            have = {self._key(Path(entry)) for entry in gateway_cp.read_text(encoding="utf-8").strip().split(os.pathsep) if entry}
            module_keys = {f"{m}" for m in project["modules"]}
            jars: dict[str, Path] = {}
            version = ""
            for module in project["modules"]:
                built = [j for j in (work / module / "target").glob("*.jar") if not j.name.endswith(("-sources.jar", "-javadoc.jar"))]
                if not built:
                    raise RuntimeError(f"No JAR was built for module {module}.")
                jars[module] = built[0]
                found = re.search(r"-(\d[\w.\-]*)$", built[0].stem)
                version = version or (found.group(1) if found else "")
                cp_file = work / module / "target" / "labradt-classpath.txt"
                for entry in (cp_file.read_text(encoding="utf-8").strip().split(os.pathsep) if cp_file.is_file() else []):
                    jar = Path(entry)
                    if not entry or jar.suffix != ".jar" or jar.parent.parent.name in module_keys:
                        continue
                    if self._key(jar) not in have:
                        jars[self._key(jar)] = jar

            step("Installing the plugin JARs")
            lib = home / "lib"
            shutil.rmtree(lib, ignore_errors=True)
            lib.mkdir(parents=True)
            for jar in jars.values():
                shutil.copy2(jar, lib / jar.name)
            plugin = {"key": project["key"], "id": project["id"], "name": project["name"], "protocol": project["protocol"],
                      "adapter": project.get("adapter"), "category": project.get("category"),
                      "version": version or "0.0.1-SNAPSHOT", "projectName": project["projectName"], "source": project["path"], "modules": project["modules"],
                      "jars": sorted(j.name for j in jars.values()), "installedAt": time.time(),
                      "installedAtText": datetime.now().isoformat(timespec="seconds")}
            (home / "plugin.json").write_text(json.dumps(plugin, indent=2), encoding="utf-8")
            shutil.rmtree(work, ignore_errors=True)
            self._apply()
            restart = self.stack.components[self.COMPONENT].health()
            self.job.update(state="done", step="", message=f"{project['name']} plugin installed ({len(jars)} JARs)."
                            + (f" Restart the {self.LABEL} to load it." if restart else f" It loads when the {self.LABEL} starts."))
        except Exception as error:
            self.job.update(state="failed", message=str(error))
            with log.open("a", encoding="utf-8") as handle:
                handle.write(f"\nFAILED: {error}\n")

    def uninstall(self, plugin_id: str, references: list[str]) -> dict[str, Any]:
        plugin = next((p for p in self.installed() if p["id"] == plugin_id or p["key"] == plugin_id), None)
        if not plugin:
            raise HTTPException(404, "Plugin is not installed")
        if references:
            raise HTTPException(409, {"message": "Remove the machine connections that use this plugin first (including disabled ones).", "references": references})
        self.stack.require_config_unlocked()
        shutil.rmtree(self.store / plugin["key"], ignore_errors=True)
        applied = self._apply()
        return {"removed": plugin["id"], "restartRequired": self.stack.components[self.COMPONENT].health(), "project": applied}

    def _apply(self) -> dict[str, Any]:
        """Hands the installed plugins over to the project's plugins/ folder (again at every start)."""
        try:
            return self.stack.apply_plugins(self.COMPONENT)
        except Exception as error:  # e.g. JARs locked by the running JVM: the next start applies them
            return {"problems": [str(error)]}

    def job_status(self) -> dict[str, Any]:
        result = dict(self.job)
        if result.get("log") and Path(result["log"]).is_file():
            result["logTail"] = "\n".join(Path(result["log"]).read_text(encoding="utf-8", errors="replace").splitlines()[-25:])
        return result


# ─────────────────────────────────────────────────────────────────────────────
# Service runtime plugins from runtime-plugins (Maven projects)
# ─────────────────────────────────────────────────────────────────────────────

RUNTIME_INTERFACES = {"IScriptInterpreter": "SCRIPT", "IContainerOrchestrator": "CONTAINER", "IExternalServiceClient": "EXTERNAL"}
RUNTIME_CATEGORY_NAMES = ("SCRIPT", "CONTAINER", "EXTERNAL")  # fixed by the Runtime; plugins add adapters (languages, runtimes) inside them
RUNTIME_CATEGORIES = {"LUA": "SCRIPT", "BASH": "SCRIPT", "DOCKER": "CONTAINER", "REST": "EXTERNAL"}
RUNTIME_NAMES = {"LUA": "Lua scripts", "BASH": "Bash scripts", "PYTHON": "Python scripts", "DOCKER": "Docker containers", "REST": "REST endpoints"}
DEFINE_SOURCE_RE = re.compile(r'TechnologyAdapter\s*\.\s*define\(\s*"([A-Za-z][A-Za-z0-9_]{0,40})"\s*,\s*ExecutionCategory\s*\.\s*(SCRIPT|CONTAINER|EXTERNAL)\s*\)')
RETURN_SOURCE_RE = re.compile(r"return\s+TechnologyAdapter\.([A-Z][A-Z0-9_]*)\s*;")


def _class_pool(data: bytes) -> tuple[list[Any], int]:
    """Constant pool of a class file (index -> entry) and the offset right after it."""
    count = int.from_bytes(data[8:10], "big")
    pool: list[Any] = [None] * count
    pos, index = 10, 1
    sizes = {3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4, 12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2}
    while index < count:
        tag = data[pos]
        if tag == 1:
            length = int.from_bytes(data[pos + 1:pos + 3], "big")
            pool[index] = ("utf8", data[pos + 3:pos + 3 + length].decode("utf-8", errors="replace"))
            pos += 3 + length
        elif tag in sizes:
            raw = data[pos + 1:pos + 1 + sizes[tag]]
            if tag in (7, 8, 16, 19, 20):
                pool[index] = (tag, int.from_bytes(raw, "big"))
            elif tag in (9, 10, 11, 12, 17, 18):
                pool[index] = (tag, int.from_bytes(raw[:2], "big"), int.from_bytes(raw[2:], "big"))
            pos += 1 + sizes[tag]
            if tag in (5, 6):
                index += 1
        else:
            raise ValueError(f"unknown constant pool tag {tag}")
        index += 1
    return pool, pos


def inspect_class(data: bytes) -> dict[str, Any]:
    """Interfaces of a class and the TechnologyAdapter it defines or returns, read from the class file.

    Finds `TechnologyAdapter.define("X", ExecutionCategory.Y)` (ldc "X"; getstatic ExecutionCategory.Y;
    invokestatic TechnologyAdapter.define) and `return TechnologyAdapter.X;` (getstatic; areturn).
    """
    if data[:4] != b"\xca\xfe\xba\xbe":
        return {}
    pool, pos = _class_pool(data)

    def utf8(i: int) -> str:
        entry = pool[i] if 0 < i < len(pool) else None
        return entry[1] if entry and entry[0] == "utf8" else ""

    def class_name(i: int) -> str:
        entry = pool[i] if 0 < i < len(pool) else None
        return utf8(entry[1]) if entry and entry[0] == 7 else ""

    def member(i: int, tag: int) -> tuple[str, str]:
        entry = pool[i] if 0 < i < len(pool) else None
        if not entry or entry[0] != tag:
            return "", ""
        nat = pool[entry[2]] if 0 < entry[2] < len(pool) else None
        return class_name(entry[1]), utf8(nat[1]) if nat and nat[0] == 12 else ""

    def string(i: int) -> str:
        entry = pool[i] if 0 < i < len(pool) else None
        return utf8(entry[1]) if entry and entry[0] == 8 else ""

    count = int.from_bytes(data[pos + 6:pos + 8], "big")
    interfaces = [class_name(int.from_bytes(data[pos + 8 + 2 * k:pos + 10 + 2 * k], "big")).rsplit("/", 1)[-1] for k in range(count)]
    defines = []
    for m in re.finditer(rb"(?:\x12(.)|\x13(..))\xb2(..)\xb8(..)", data, re.S):
        name = string(m.group(1)[0] if m.group(1) else int.from_bytes(m.group(2), "big"))
        owner, category = member(int.from_bytes(m.group(3), "big"), 9)
        target, method = member(int.from_bytes(m.group(4), "big"), 10)
        if name and owner.endswith("/ExecutionCategory") and target.endswith("/TechnologyAdapter") and method == "define":
            defines.append((name.upper(), category))
    returned = []
    for m in re.finditer(rb"\xb2(..)\xb0", data, re.S):
        owner, field = member(int.from_bytes(m.group(1), "big"), 9)
        if owner.endswith("/TechnologyAdapter"):
            returned.append(field)
    return {"interfaces": interfaces, "defines": defines, "returns": returned}


def inspect_runtime_jar(path: Path) -> dict[str, Any] | None:
    """What a runtime plugin JAR provides: adapter, category, Maven coordinates (from META-INF/maven), or None."""
    import zipfile
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile):
        return None
    with archive:
        names = archive.namelist()
        if any(n.startswith("BOOT-INF/") for n in names):
            raise HTTPException(422, "This is an executable Spring Boot JAR (an application), not a plugin library. "
                                     "Choose the plugin's own JAR (mvn package in the plugin project, target/*.jar).")
        adapter = category = implemented = None
        for name in names:
            if not name.endswith(".class") or name.startswith("META-INF/"):
                continue
            try:
                info = inspect_class(archive.read(name))
            except (ValueError, IndexError, KeyError):
                continue
            if info.get("defines"):
                adapter, category = info["defines"][0]
            kinds = [RUNTIME_INTERFACES[i] for i in info.get("interfaces", []) if i in RUNTIME_INTERFACES]
            if kinds:
                implemented = implemented or kinds[0]
                if not adapter and info.get("returns"):
                    adapter = info["returns"][0]
        if not implemented or not adapter:
            return None
        maven = None
        props = [n for n in names if n.startswith("META-INF/maven/") and n.endswith("/pom.properties")]
        if props:
            text = archive.read(props[0]).decode("utf-8", errors="replace")
            values = dict(line.split("=", 1) for line in text.splitlines() if "=" in line and not line.startswith("#"))
            pom_name = props[0][:-len("pom.properties")] + "pom.xml"
            maven = {"groupId": values.get("groupId", "").strip(), "artifactId": values.get("artifactId", "").strip(),
                     "version": values.get("version", "").strip(), "pom": archive.read(pom_name).decode("utf-8", errors="replace") if pom_name in names else ""}
        return {"adapter": adapter, "category": category or RUNTIME_CATEGORIES.get(adapter) or implemented, "implements": implemented, "maven": maven}


class RuntimePluginProjects(GatewayPluginProjects):
    """Runtimes (Lua, Python, Docker, REST, ...): plugins of the Runtime, loaded into the Service Manager.

    The categories SCRIPT / CONTAINER / EXTERNAL are fixed; a plugin adds a technology adapter inside one of them
    (e.g. SCRIPT/PYTHON). Registered services are instances that name their runtime (category + adapter).
    A plugin comes as a Maven project folder (built like Gateway plugins) or as a built JAR. The Service Manager
    finds plugin beans by component scan (de.labradt.serviceexecution), so the plugin JARs only have to be on its
    classpath: the UI starts it with spring-boot.run.additional-classpath-elements.
    """
    COMPONENT, LABEL, HOST_MODULE, LOG_PREFIX = "runtime", "Runtime", "service-manager-app", "runtime-plugin"
    START_ENV, START_SIBLING = "LABRADT_RUNTIME_PLUGINS_DIR", "runtime-plugins"

    def host_dir(self) -> Path:
        return self.stack.runtime_dir

    def adapt(self, path: Path, text: str) -> str:
        text = text.replace("isw.digitaltwin", "de.labradt")
        if path.name == "pom.xml":
            text = text.replace("<artifactId>service-execution-parent</artifactId>", "<artifactId>runtime-parent</artifactId>")
        return text

    def switches(self) -> dict[str, str]:
        return {}

    @staticmethod
    def _summary(folder: Path) -> str:
        readme = folder / "README.md"
        if not readme.is_file():
            return ""
        paragraphs = [" ".join(l.strip() for l in block.splitlines()) for block in readme.read_text(encoding="utf-8", errors="replace").split("\n\n")]
        return next((t for t in paragraphs if t and not t.startswith(("#", "*", "|", "`", "<", "!", "["))), "")

    def _entry(self, key: str, adapter: str, category: str, **extra: Any) -> dict[str, Any]:
        key = re.sub(r"[^A-Za-z0-9._-]+", "-", key).strip("-") or adapter.lower()
        return {"key": key, "id": "runtime:" + adapter, "protocol": adapter, "adapter": adapter, "category": category,
                "technology": f"{category}/{adapter}", "name": RUNTIME_NAMES.get(adapter, adapter.title()),
                "installed": key in {p["key"] for p in self.installed()}, **extra}

    def describe(self, folder: Path) -> dict[str, Any] | None:
        try:
            pom = (folder / "pom.xml").read_text(encoding="utf-8", errors="replace") if (folder / "pom.xml").is_file() else ""
        except OSError:
            return None
        if not pom or "<module>" in pom or not re.search(r"<artifactId>\s*(runtime-(script|container|external)|core-api)\s*</artifactId>", pom):
            return None  # not a plugin (e.g. the runtime core itself, which aggregates modules)
        sources = list((folder / "src" / "main" / "java").rglob("*.java")) if (folder / "src" / "main" / "java").is_dir() else []
        adapter = category = implemented = None
        for source in sources:
            text = source.read_text(encoding="utf-8", errors="replace")
            defined = DEFINE_SOURCE_RE.search(text)
            if defined:
                adapter, category = defined.group(1).upper(), defined.group(2)
            kind = next((cat for name, cat in RUNTIME_INTERFACES.items() if re.search(r"implements[^{]*\b" + name + r"\b", text)), None)
            if kind:
                implemented = implemented or kind
                returned = RETURN_SOURCE_RE.search(text)
                if returned and not adapter:
                    adapter = returned.group(1)
        if not adapter or not implemented:
            return None
        category = category or RUNTIME_CATEGORIES.get(adapter) or implemented
        artifact = re.search(r"<artifactId>\s*([^<]+?)\s*</artifactId>", re.sub(r"<parent>.*?</parent>", "", pom, flags=re.S))
        return self._entry(folder.name, adapter, category, kind="project", projectName=folder.name,
                           artifact=artifact.group(1) if artifact else folder.name, modules=["."], summary=self._summary(folder))

    def describe_jar(self, jar: Path) -> dict[str, Any] | None:
        info = inspect_runtime_jar(jar)
        if not info:
            return None
        maven = info["maven"] or {}
        stem = maven.get("artifactId") or re.sub(r"-\d[\w.\-]*$", "", jar.stem)
        return self._entry(stem, info["adapter"], info["category"], kind="jar", projectName=jar.name, artifact=stem, modules=[],
                           maven=maven or None, version=maven.get("version", ""),
                           summary=("Built JAR" + (f" {maven['groupId']}:{maven['artifactId']}:{maven['version']}" if maven else "")
                                    + ("; its dependencies are resolved with Maven." if maven else "; no Maven metadata inside, so it is installed alone (it must bring its dependencies).")))

    def list_dirs(self, path: str | None, describe: bool = True) -> dict[str, Any]:
        listing = super().list_dirs(path, describe)
        listing["jars"] = []
        if listing.get("path"):
            try:
                listing["jars"] = [{"name": f.name, "path": str(f), "size": f.stat().st_size}
                                   for f in sorted(Path(listing["path"]).glob("*.jar"), key=lambda f: f.name.lower())
                                   if f.is_file() and not f.name.endswith(("-sources.jar", "-javadoc.jar"))][:200]
            except OSError:
                pass
        return listing

    def inspect(self, path: str) -> dict[str, Any]:
        target = Path(str(path or "").strip().strip('"')).expanduser()
        if target.is_file() and target.suffix.lower() == ".jar":
            info = self.describe_jar(target.resolve())
            if not info:
                raise HTTPException(422, "No service runtime in this JAR: it needs a class that implements IScriptInterpreter, "
                                         "IContainerOrchestrator or IExternalServiceClient and returns a TechnologyAdapter "
                                         "(a built-in one or TechnologyAdapter.define(\"NAME\", ExecutionCategory.SCRIPT|CONTAINER|EXTERNAL)).")
            return {**info, "path": str(target.resolve())}
        if not str(path or "").strip() or not target.is_dir():
            raise HTTPException(404, "Not found. Choose the runtime plugin project folder (with its pom.xml) or a built plugin .jar.")
        info = self.describe(target.resolve())
        if not info:
            raise HTTPException(422, "No service runtime plugin project in this folder: it needs a pom.xml that depends on the runtime "
                                     "(runtime-script, runtime-container or runtime-external) and a class that implements its interface "
                                     "(e.g. IScriptInterpreter) and returns a TechnologyAdapter.")
        return {**info, "path": str(target.resolve())}

    def save_upload(self, filename: str, content_b64: str) -> dict[str, Any]:
        """Stores a JAR uploaded from the browser and inspects it (install it afterwards with its returned path)."""
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(str(filename or "")).name).strip("-")
        if not name.lower().endswith(".jar"):
            raise HTTPException(422, "Upload a .jar file.")
        try:
            data = base64.b64decode(content_b64 or "", validate=False)
        except ValueError as error:
            raise HTTPException(422, "The upload is not valid base64.") from error
        if not data:
            raise HTTPException(422, "The uploaded file is empty.")
        folder = self.store / "_uploads"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / name
        target.write_bytes(data)
        return self.inspect(str(target))

    def uninstall(self, plugin_id: str, references: list[str]) -> dict[str, Any]:
        if references:
            raise HTTPException(409, {"message": "Services in the registry still use this runtime. Remove those service instances first.", "references": references})
        return super().uninstall(plugin_id, [])

    def _install(self, project: dict[str, Any], log: Path) -> None:
        if project.get("kind") != "jar":
            return super()._install(project, log)
        try:
            self._install_jar(project, log)
        except Exception as error:
            self.job.update(state="failed", message=str(error))
            with log.open("a", encoding="utf-8") as handle:
                handle.write(f"\nFAILED: {error}\n")

    def _install_jar(self, project: dict[str, Any], log: Path) -> None:
        def step(text: str) -> None:
            self.job.update(step=text)
            with log.open("a", encoding="utf-8") as handle:
                handle.write(f"\n--- {text}\n")
        jar = Path(project["path"])
        home = self.store / project["key"]
        lib = home / "lib"
        extra_jars: list[Path] = []
        note = ""
        maven_info = project.get("maven") or {}
        runtime = self.stack.components[self.COMPONENT]
        maven = runtime.maven()
        if maven_info.get("groupId") and maven_info.get("version") and maven_info.get("pom") and maven:
            extra = self.stack.extra_mvn
            work = home / "build"
            shutil.rmtree(work, ignore_errors=True)
            work.mkdir(parents=True)
            try:
                if not runtime.marker.exists() and self.host_dir().is_dir():
                    step("Installing the Runtime core into the local Maven repository")
                    if self._run(maven + extra + ["-DskipTests", "install"], self.host_dir(), log):
                        raise RuntimeError("Runtime core build failed - see the plugin log.")
                    runtime.marker.parent.mkdir(parents=True, exist_ok=True)
                    runtime.marker.write_text(datetime.now().isoformat(), encoding="utf-8")
                step("Registering the JAR in the local Maven repository")
                (work / "plugin-pom.xml").write_text(self.adapt(Path("pom.xml"), maven_info["pom"]), encoding="utf-8")
                if self._run(maven + extra + ["-q", "install:install-file", f"-Dfile={jar}", f"-DpomFile={work / 'plugin-pom.xml'}"], work, log):
                    raise RuntimeError("install:install-file failed")
                step("Resolving the plugin dependencies")
                g, a, v = maven_info["groupId"], maven_info["artifactId"], maven_info["version"]
                (work / "pom.xml").write_text(
                    "<project xmlns=\"http://maven.apache.org/POM/4.0.0\"><modelVersion>4.0.0</modelVersion>"
                    "<groupId>labradt.staging</groupId><artifactId>runner-staging</artifactId><version>1</version><packaging>pom</packaging>"
                    f"<dependencies><dependency><groupId>{g}</groupId><artifactId>{a}</artifactId><version>{v}</version></dependency></dependencies></project>\n",
                    encoding="utf-8")
                host_cp = home / "host-classpath.txt"
                if self._run(maven + extra + ["-q", "-pl", self.HOST_MODULE, "dependency:build-classpath", "-Dmdep.includeScope=runtime",
                                              f"-Dmdep.outputFile={host_cp}"], self.host_dir(), log):
                    raise RuntimeError("could not resolve the Runtime classpath")
                if self._run(maven + extra + ["-q", "dependency:build-classpath", "-Dmdep.includeScope=runtime",
                                              "-Dmdep.outputFile=plugin-classpath.txt"], work, log):
                    raise RuntimeError("could not resolve the plugin dependencies")
                have = {self._key(Path(e)) for e in host_cp.read_text(encoding="utf-8").strip().split(os.pathsep) if e}
                for entry in (work / "plugin-classpath.txt").read_text(encoding="utf-8").strip().split(os.pathsep):
                    dep = Path(entry)
                    if entry and dep.suffix == ".jar" and dep.parent.parent.name != a and self._key(dep) not in have:
                        extra_jars.append(dep)
            except RuntimeError as error:
                extra_jars, note = [], f" Dependencies could not be resolved ({error}); installed the JAR alone."
                with log.open("a", encoding="utf-8") as handle:
                    handle.write(f"WARNING:{note}\n")
            finally:
                shutil.rmtree(work, ignore_errors=True)
        elif not maven_info:
            note = " No Maven metadata in the JAR: installed alone, so it must bring its own dependencies."
        step("Installing the plugin JARs")
        shutil.rmtree(lib, ignore_errors=True)
        lib.mkdir(parents=True)
        for item in [jar] + extra_jars:
            shutil.copy2(item, lib / item.name)
        plugin = {"key": project["key"], "id": project["id"], "name": project["name"], "protocol": project["protocol"],
                  "adapter": project["adapter"], "category": project["category"], "kind": "jar",
                  "version": project.get("version") or "", "projectName": project["projectName"], "source": project["path"], "modules": [],
                  "jars": sorted({jar.name} | {j.name for j in extra_jars}), "installedAt": time.time(),
                  "installedAtText": datetime.now().isoformat(timespec="seconds")}
        (home / "plugin.json").write_text(json.dumps(plugin, indent=2), encoding="utf-8")
        self._apply()
        if jar.parent == self.store / "_uploads":
            jar.unlink(missing_ok=True)
        restart = runtime.health()
        self.job.update(state="done", step="", message=f"{project['category']}/{project['adapter']} runtime installed ({len(plugin['jars'])} JARs)." + note
                        + (" Restart the Runtime to load it." if restart else " It loads when the Runtime starts."))


# ─────────────────────────────────────────────────────────────────────────────
# Service packages: turn a chosen file / folder into what the runtime can execute
# ─────────────────────────────────────────────────────────────────────────────

LUA_BUNDLE_LOADER = """
local __labradt_loaded = {}
local function require(name)
  local value = __labradt_loaded[name]
  if value ~= nil then return value end
  local loader = __labradt_modules[name] or __labradt_modules[(string.gsub(name, "/", "."))]
  if not loader then error("module '" .. tostring(name) .. "' is not part of this service bundle", 2) end
  value = loader(name)
  if value == nil then value = true end
  __labradt_loaded[name] = value
  return value
end
"""


def bundle_lua(folder: Path) -> tuple[str, str, list[str]]:
    """One script from a Lua folder: the entry script plus every other .lua file as a module for require()."""
    files = sorted(p for p in folder.rglob("*.lua") if not any(part.startswith(".") for part in p.relative_to(folder).parts))
    if not files:
        raise ValueError("The folder contains no .lua file.")
    entry = next((folder / name for name in ("main.lua", "init.lua") if (folder / name).is_file()), files[0] if len(files) == 1 else None)
    if entry is None:
        raise ValueError("A Lua folder needs main.lua (or init.lua) as entry script.")
    modules = [p for p in files if p != entry]
    parts = [f"-- LABraDT service bundle of {folder.name}: {entry.name}" + (f" + {len(modules)} module(s)" if modules else ""),
             "local __labradt_modules = {}"]
    names = []
    for module in modules:
        name = ".".join(module.relative_to(folder).with_suffix("").parts)
        names.append(name)
        parts.append(f"__labradt_modules[{json.dumps(name)}] = function(...)\n{module.read_text(encoding='utf-8')}\nend")
    if modules:
        parts.append(LUA_BUNDLE_LOADER)
    parts.append(f"-- entry: {entry.name}\n" + entry.read_text(encoding="utf-8"))
    return "\n".join(parts) + "\n", entry.name, names


PYTHON_DOCKERFILE = """# Generated by the LABraDT UI for a Python service folder (entry: main.py)
FROM python:3.12-slim
WORKDIR /app
COPY . /app
{install}CMD ["python", "-u", "main.py"]
"""


PYTHON_PACK_HEADER = "# labradt:pyz base64"  # read by the Python runtime plugin (runtime-plugins/python-runtime-plugins)
PYTHON_PACK_MAIN = "import runpy\nrunpy.run_module('main', run_name='__main__')\n"


def pack_python(folder: Path) -> tuple[str, list[str]]:
    """A Python folder as one text: a zip application (main.py + its modules/data, __main__.py added), base64 encoded."""
    import io
    import zipfile
    skip = {".git", "__pycache__", ".venv", "venv", ".idea", ".mypy_cache", ".pytest_cache", "node_modules"}
    files = sorted(p for p in folder.rglob("*") if p.is_file() and not (set(p.relative_to(folder).parts) & skip)
                   and not p.name.endswith((".pyc", ".pyo")) and p.name != "__main__.py")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("__main__.py", PYTHON_PACK_MAIN)
        for f in files:
            archive.write(f, f.relative_to(folder).as_posix())
    encoded = base64.encodebytes(buffer.getvalue()).decode("ascii")
    if len(encoded) > 1_000_000:  # the Engine storage takes files up to 1 MB (Spring's default multipart limit)
        raise RuntimeError(f"The packed Python folder is {len(encoded) // 1024} KB; the Engine storage takes up to 1 MB per file. "
                           "Remove data files or virtual environments from the folder, or run it as a container (Docker runtime).")
    return f"{PYTHON_PACK_HEADER}\n{encoded}", [f.relative_to(folder).as_posix() for f in files]


class ServicePackager:
    """Prepares the File / Endpoint of a service registration as a background job.

    LUA        .lua file -> engine storage · folder -> one bundled script (main.lua + modules) -> engine storage
    CONTAINER  folder with Dockerfile -> docker build (image) · Dockerfile -> engine storage · image .tar -> docker load
    PYTHON     with the Python runtime (SCRIPT/PYTHON): .py file -> engine storage · folder with main.py -> packed
               zip application (base64 text) -> engine storage; without it, but with the Docker runtime:
               folder with main.py -> container image (python:3.12-slim)
    other SCRIPT runtimes added by plugins: one script file -> engine storage
    REST / other plugins: the value is kept as typed (URL or any string).
    """

    def __init__(self, stack: "Stack"):
        self.stack = stack
        self.jobs: dict[str, dict[str, Any]] = {}

    def docker(self) -> str | None:
        return os.getenv("DOCKER_CMD") or shutil.which("docker")

    def start(self, payload: dict[str, Any]) -> dict[str, Any]:
        job_id = f"pkg-{int(time.time() * 1000)}"
        log = self.stack.log_dir / f"service-package-{job_id}.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text("", encoding="utf-8")
        job = {"id": job_id, "state": "running", "step": "Checking", "message": "", "log": str(log), "result": None}
        self.jobs = {k: v for k, v in self.jobs.items() if v["state"] == "running"} | {job_id: job}
        threading.Thread(target=self._run, args=(job, payload), daemon=True).start()
        time.sleep(0.2)
        return self.status(job_id)

    def status(self, job_id: str) -> dict[str, Any]:
        job = self.jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Unknown packaging job")
        result = {k: v for k, v in job.items() if k != "log"}
        try:
            result["logTail"] = "\n".join(Path(job["log"]).read_text(encoding="utf-8", errors="replace").splitlines()[-30:])
        except OSError:
            result["logTail"] = ""
        return result

    def _say(self, job: dict[str, Any], text: str) -> None:
        with open(job["log"], "a", encoding="utf-8") as handle:
            handle.write(text + "\n")

    def _cmd(self, job: dict[str, Any], args: list[str], cwd: Path | None = None) -> tuple[int, str]:
        self._say(job, "$ " + " ".join(args))
        with open(job["log"], "a", encoding="utf-8", errors="replace") as handle:
            proc = subprocess.run(args, cwd=str(cwd) if cwd else None, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
            handle.write(proc.stdout)
        return proc.returncode, proc.stdout

    def _upload(self, name: str, text: str) -> str:
        try:
            return self.stack.upload_to_engine(name, base64.b64encode(text.encode("utf-8")).decode("ascii"))
        except HTTPException as error:
            if error.status_code == 502:
                raise RuntimeError("The Engine is not running. Start it on the System page: it stores the scripts and Dockerfiles of services.") from error
            raise RuntimeError(f"Engine storage refused the file: {error.detail}") from error

    def _docker_build(self, job: dict[str, Any], context: Path, tag: str) -> str:
        docker = self.docker()
        if not docker:
            raise RuntimeError("Docker is not installed (or not on PATH). Install Docker Desktop / Docker Engine on this computer, or set DOCKER_CMD.")
        job["step"] = f"Building image {tag} (docker build)"
        code, _ = self._cmd(job, [docker, "build", "-t", tag, str(context)])
        if code:
            raise RuntimeError(f"docker build failed (exit {code}) - see the log.")
        return tag

    def _runtime_has(self, adapter: str) -> bool:
        return any(p.get("adapter") == adapter for p in self.stack.runtime_plugins.installed())

    def _run(self, job: dict[str, Any], payload: dict[str, Any]) -> None:
        try:
            job["result"] = self._prepare(job, payload)
            job.update(state="done", step="", message=job["result"].get("summary", "Ready."))
        except Exception as error:
            self._say(job, f"FAILED: {error}")
            job.update(state="failed", step="", message=str(error))

    def _prepare(self, job: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        runtime_type = str(payload.get("runtimeType") or "").upper()
        value = str(payload.get("value") or "").strip().strip('"')
        service_id = re.sub(r"[^a-z0-9_.-]+", "-", str(payload.get("serviceId") or "service").lower()).strip("-") or "service"
        keep = {"action": "keep", "fileReference": value, "defaultArgs": {}, "summary": "Kept as entered."}
        if not value or runtime_type == "REST" or re.match(r"^[a-z][a-z0-9+.-]*://", value, re.I):
            return keep
        path = Path(value).expanduser()
        if not (path.is_absolute() and path.exists()):
            return keep  # an existing storage key, an image name or a plugin-specific string
        path = path.resolve()
        self._say(job, f"Preparing {runtime_type or 'service'} from {path}")

        if runtime_type in ("LUA", "BASH"):
            if path.is_dir():
                if runtime_type == "BASH":
                    raise RuntimeError("Bash services take one script file.")
                job["step"] = "Bundling the Lua folder"
                text, entry, modules = bundle_lua(path)
                self._say(job, f"Entry {entry}; modules: {', '.join(modules) or 'none'}")
                name, summary = f"{service_id}.lua", f"Bundled {entry}" + (f" with {len(modules)} module(s)" if modules else "")
            else:
                text, name, summary = path.read_text(encoding="utf-8"), path.name, f"Script {path.name}"
            job["step"] = "Uploading to the Engine storage"
            ref = self._upload(name, text)
            return {"action": "upload", "fileReference": ref, "defaultArgs": {}, "summary": f"{summary} stored as {ref}."}

        if runtime_type == "CONTAINER":
            if path.is_dir():
                if not any((path / n).is_file() for n in ("Dockerfile", "Containerfile")):
                    raise RuntimeError("The folder needs a Dockerfile (the build context is the whole folder).")
                tag = self._docker_build(job, path, f"labradt/{service_id}:latest")
                return {"action": "image", "fileReference": "", "defaultArgs": {"image": tag}, "summary": f"Image {tag} built from {path.name}."}
            if path.suffix.lower() in (".tar", ".gz", ".tgz") or path.name.lower().endswith(".tar.gz"):
                docker = self.docker()
                if not docker:
                    raise RuntimeError("Docker is not installed (or not on PATH). Install Docker on this computer, or set DOCKER_CMD.")
                job["step"] = "Loading the image archive (docker load)"
                code, out = self._cmd(job, [docker, "load", "-i", str(path)])
                found = re.findall(r"Loaded image(?: ID)?:\s*(\S+)", out)
                if code or not found:
                    raise RuntimeError("docker load failed or reported no image - see the log.")
                return {"action": "image", "fileReference": "", "defaultArgs": {"image": found[-1]}, "summary": f"Image {found[-1]} loaded from {path.name}."}
            job["step"] = "Uploading the Dockerfile to the Engine storage"
            ref = self._upload(path.name if "dockerfile" in path.name.lower() or "containerfile" in path.name.lower() else f"{service_id}.Dockerfile",
                               path.read_text(encoding="utf-8"))
            return {"action": "upload", "fileReference": ref, "defaultArgs": {}, "summary": f"{path.name} stored as {ref}; the runtime builds it (Docker needed there)."}

        if runtime_type == "PYTHON":
            if self._runtime_has("PYTHON"):
                if path.is_file():
                    if path.suffix.lower() != ".py":
                        raise RuntimeError("Choose a .py script or a folder with main.py.")
                    job["step"] = "Uploading the script to the Engine storage"
                    ref = self._upload(path.name, path.read_text(encoding="utf-8"))
                    return {"action": "upload", "fileReference": ref, "defaultArgs": {}, "summary": f"{path.name} stored as {ref}."}
                if not (path / "main.py").is_file():
                    raise RuntimeError("A Python service folder needs main.py.")
                job["step"] = "Packing the Python folder"
                text, files = pack_python(path)
                if files == ["main.py"]:
                    text = (path / "main.py").read_text(encoding="utf-8")
                self._say(job, f"Files: {', '.join(files)}")
                if (path / "requirements.txt").is_file():
                    self._say(job, "Note: requirements.txt is not installed automatically; install the packages into the Runtime's Python.")
                job["step"] = "Uploading to the Engine storage"
                ref = self._upload(f"{service_id}.py" if files == ["main.py"] else f"{service_id}.pyz.txt", text)
                return {"action": "upload", "fileReference": ref, "defaultArgs": {}, "category": "SCRIPT", "adapter": "PYTHON",
                        "summary": (f"main.py stored as {ref}." if files == ["main.py"] else f"{path.name} packed ({len(files)} files, entry main.py) and stored as {ref}.")
                        + (" Install requirements.txt into the Runtime's Python." if (path / "requirements.txt").is_file() else "")}
            folder = path if path.is_dir() else path.parent
            if not (folder / "main.py").is_file():
                raise RuntimeError("A Python service needs a folder with main.py.")
            if not self._runtime_has("DOCKER"):
                raise RuntimeError("Python services need a runtime: add the Python runtime plugin (SCRIPT/PYTHON), "
                                   "or the Docker runtime to run them in a container.")
            job["step"] = "Preparing the build context"
            context = self.stack.state_dir / "service-builds" / service_id
            shutil.rmtree(context, ignore_errors=True)
            shutil.copytree(folder, context, ignore=shutil.ignore_patterns(".git", "__pycache__", ".venv", "venv", "*.pyc", ".idea"))
            if not (context / "Dockerfile").is_file():
                install = "RUN pip install --no-cache-dir -r requirements.txt\n" if (context / "requirements.txt").is_file() else ""
                (context / "Dockerfile").write_text(PYTHON_DOCKERFILE.format(install=install), encoding="utf-8")
                self._say(job, "Generated a Dockerfile (python:3.12-slim, CMD python -u main.py)")
            tag = self._docker_build(job, context, f"labradt/{service_id}:latest")
            return {"action": "image", "fileReference": "", "defaultArgs": {"image": tag}, "category": "CONTAINER", "adapter": "DOCKER",
                    "summary": f"Image {tag} built from {folder.name}/main.py; arguments arrive as environment variables."}

        plugin = next((p for p in self.stack.runtime_plugins.installed() if p.get("adapter") == runtime_type), None)
        if plugin and plugin.get("category") == "SCRIPT":
            # a script language added by a plugin: the script host reads the script text from the Engine storage
            if path.is_dir():
                raise RuntimeError(f"{runtime_type} services take one script file (choose the file, not the folder).")
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError as error:
                raise RuntimeError("Script runtimes read text: choose a UTF-8 script file.") from error
            job["step"] = "Uploading the script to the Engine storage"
            ref = self._upload(path.name, text)
            return {"action": "upload", "fileReference": ref, "defaultArgs": {}, "summary": f"{path.name} stored as {ref} for the {runtime_type} runtime."}

        return keep  # another plugin: we do not know its format, keep the path / string


# ─────────────────────────────────────────────────────────────────────────────
# Address-space explorer: one tree model for every protocol
# ─────────────────────────────────────────────────────────────────────────────
# A tree node: {"id", "name", "children": [...]} for branches; leaves (selectable signals) add
# {"address", "valueType", "value", "updatedAt", "writable"}. A node can be both (MQTT topic with sub-topics).

class ExplorerSession:
    live = False

    def __init__(self, payload: dict[str, Any]):
        self.payload = payload
        self.state, self.error, self.message = "connecting", "", ""
        self.last_poll = time.time()
        self.lock = threading.Lock()

    def tree(self) -> list[dict[str, Any]]:
        return []

    def count(self) -> int:
        return 0

    def close(self) -> None:
        pass


class MqttExplorerSession(ExplorerSession):
    """Keeps a subscription open and collects every topic the broker delivers (retained ones at once)."""
    live = True

    def __init__(self, payload: dict[str, Any], username: str, password: str):
        super().__init__(payload)
        self.topics: dict[str, dict[str, Any]] = {}
        try:
            import paho.mqtt.client as mqtt
        except ImportError as error:
            raise HTTPException(503, "MQTT exploring needs paho-mqtt:  pip install paho-mqtt") from error
        endpoint = str(payload.get("endpoint", "")).strip()
        host = re.sub(r"^(tcp|mqtt|ssl|ws|wss)://", "", endpoint)
        port = 1883
        if ":" in host:
            host, port_text = host.rsplit(":", 1)
            port = int(port_text.split("/")[0])
        self.filter = str(payload.get("topicFilter") or "#").strip() or "#"
        try:
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"labradt-explorer-{os.getpid()}-{int(time.time()*1000) % 100000}")
        except AttributeError:
            client = mqtt.Client(client_id=f"labradt-explorer-{os.getpid()}")
        if username:
            client.username_pw_set(username, password)
        client.on_message = self._message
        client.on_connect = lambda c, u, f, rc, *rest: self._connected(c, rc)
        client.on_disconnect = lambda *args: setattr(self, "state", "disconnected") if self.state != "closed" else None
        self.client = client
        try:
            client.connect(host, port, keepalive=15)
        except Exception as error:
            raise HTTPException(502, f"Could not connect to the broker {host}:{port}: {error}") from error
        client.loop_start()

    def _connected(self, client, rc) -> None:
        code = getattr(rc, "value", rc)
        if code == 0:
            client.subscribe(self.filter, qos=1)
            self.state, self.message = "listening", f"Subscribed to {self.filter}"
        else:
            self.state, self.error = "failed", f"Broker refused the connection ({rc})"

    def _message(self, _client, _userdata, msg) -> None:
        text = msg.payload.decode(errors="replace")
        value, dtype = text, "xs:string"
        try:
            parsed = json.loads(text)
            value = parsed["value"] if isinstance(parsed, dict) and "value" in parsed else parsed
            dtype = infer_type(value)
        except Exception:
            pass
        with self.lock:
            entry = self.topics.setdefault(msg.topic, {"count": 0})
            entry.update(value=str(value)[:120], valueType=dtype, updatedAt=time.time(), retained=bool(msg.retain))
            entry["count"] += 1

    def count(self) -> int:
        return len(self.topics)

    def tree(self) -> list[dict[str, Any]]:
        root: dict[str, Any] = {"children": {}}
        with self.lock:
            items = sorted(self.topics.items())
        for topic, data in items:
            node, path = root, []
            for part in topic.split("/"):
                path.append(part)
                node = node["children"].setdefault(part, {"id": "/".join(path), "name": part or "(empty)", "children": {}})
            node.update(address=topic, valueType=data["valueType"], value=data["value"], updatedAt=data["updatedAt"],
                        messages=data["count"], retained=data["retained"])

        def finish(node: dict[str, Any]) -> dict[str, Any]:
            children = [finish(c) for c in node["children"].values()]
            return {**{k: v for k, v in node.items() if k != "children"}, "children": children}
        return [finish(c) for c in root["children"].values()]

    def close(self) -> None:
        self.state = "closed"
        try:
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:
            pass


class OpcuaExplorerSession(ExplorerSession):
    """Walks the OPC UA address space once (Objects folder) and keeps the node tree."""

    def __init__(self, payload: dict[str, Any], client_factory: Callable[[dict], Any]):
        super().__init__(payload)
        self.nodes: list[dict[str, Any]] = []
        self.total = 0
        self.client_factory = client_factory
        threading.Thread(target=self._walk, daemon=True).start()

    def _walk(self) -> None:
        try:
            from asyncua import ua
        except ImportError:
            self.state, self.error = "failed", "OPC UA exploring needs the asyncua package."
            return
        try:
            client = self.client_factory(self.payload)
            client.connect()
        except HTTPException as error:
            self.state, self.error = "failed", str(error.detail)
            return
        except Exception as error:
            self.state, self.error = "failed", f"Could not connect: {error}"
            return
        self.state = "browsing"
        limit = 5000

        def walk(node, depth: int, path: str) -> list[dict[str, Any]]:
            out = []
            if depth > 12 or self.total >= limit:
                return out
            try:
                children = node.get_children()
            except Exception:
                return out
            for child in children:
                if self.state == "closed" or self.total >= limit:
                    break
                try:
                    if child.nodeid.NamespaceIndex == 0:
                        continue
                    node_class = child.read_node_class()
                    name = child.read_browse_name().Name
                except Exception:
                    continue
                address = child.nodeid.to_string()
                if node_class == ua.NodeClass.Variable:
                    try:
                        value = child.read_value()
                    except Exception:
                        value = None
                    if isinstance(value, ua.NodeId):
                        continue
                    try:
                        levels = child.get_user_access_level()
                        writable = any(getattr(level, "name", "") == "CurrentWrite" for level in levels)
                    except Exception:
                        writable = None
                    self.total += 1
                    leaf = {"id": address, "name": name, "address": address, "valueType": infer_type(value),
                            "value": "" if value is None else str(value)[:120], "writable": writable, "updatedAt": time.time(), "children": []}
                    leaf["children"] = walk(child, depth + 1, path + "/" + name)  # variables can have properties
                    out.append(leaf)
                elif node_class == ua.NodeClass.Object:
                    sub = walk(child, depth + 1, path + "/" + name)
                    if sub:
                        out.append({"id": address, "name": name, "children": sub})
            return out
        try:
            self.nodes = walk(client.nodes.objects, 0, "")
            self.state = "done"
            self.message = f"{self.total} variables" + (f" (stopped at {limit})" if self.total >= limit else "")
        except Exception as error:
            self.state, self.error = "failed", f"Browsing failed: {error}"
        finally:
            try:
                client.disconnect()
            except Exception:
                pass

    def count(self) -> int:
        return self.total

    def tree(self) -> list[dict[str, Any]]:
        return self.nodes

    def close(self) -> None:
        self.state = "closed"


class Explorer:
    """Address-space explorer sessions; one provider per protocol plugin."""
    PROVIDERS = ("MQTT", "OPC_UA")

    def __init__(self, stack: "Stack"):
        self.stack = stack
        self.sessions: dict[str, ExplorerSession] = {}
        self.lock = threading.Lock()

    def _expire(self) -> None:
        now = time.time()
        for sid, session in list(self.sessions.items()):
            if now - session.last_poll > 90:
                session.close()
                self.sessions.pop(sid, None)

    def start(self, payload: dict[str, Any]) -> dict[str, Any]:
        protocol = str(payload.get("protocol", "")).upper()
        endpoint = str(payload.get("endpoint", "")).strip()
        if protocol not in self.PROVIDERS:
            raise HTTPException(400, f"No address-space explorer for {protocol or 'this protocol'} yet (available: {', '.join(self.PROVIDERS)}).")
        if not endpoint:
            raise HTTPException(400, "Enter the endpoint / broker URL first.")
        with self.lock:
            self._expire()
            if len(self.sessions) >= 8:
                raise HTTPException(429, "Too many open explorers; close one first.")
        if protocol == "MQTT":
            lookup = lambda name: self.stack.credentials.get(name) or os.environ.get(name) or ""
            username = payload.get("username") or (lookup(str(payload["usernameEnv"])) if payload.get("usernameEnv") else "")
            password = payload.get("password") or (lookup(str(payload["passwordEnv"])) if payload.get("passwordEnv") else "")
            session: ExplorerSession = MqttExplorerSession(payload, username, password)
        else:
            if not endpoint.startswith("opc.tcp://"):
                raise HTTPException(400, "OPC UA endpoints start with opc.tcp://")
            if not self.stack.opcua_client:
                raise HTTPException(503, "OPC UA exploring is not available.")
            session = OpcuaExplorerSession(payload, self.stack.opcua_client)
        sid = f"{protocol.lower()}-{int(time.time() * 1000)}-{len(self.sessions)}"
        with self.lock:
            self.sessions[sid] = session
        return {"id": sid, "protocol": protocol, "live": session.live, "state": session.state}

    def snapshot(self, sid: str) -> dict[str, Any]:
        session = self.sessions.get(sid)
        if not session:
            raise HTTPException(404, "Explorer session expired; open the explorer again.")
        session.last_poll = time.time()
        return {"id": sid, "live": session.live, "state": session.state, "error": session.error, "message": session.message,
                "count": session.count(), "tree": session.tree(), "updatedAt": time.time()}

    def stop(self, sid: str) -> dict[str, Any]:
        session = self.sessions.pop(sid, None)
        if session:
            session.close()
        return {"closed": bool(session)}


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────

def install_stack(app: Any, stack: Stack) -> None:
    async def body(request: Request) -> dict[str, Any]:
        try:
            data = await request.json()
        except Exception:
            data = {}
        return data if isinstance(data, dict) else {}

    @app.get("/api/stack")
    def stack_overview():
        return stack.overview()

    # Project folders of the three components and the hand-over of plugins into them
    @app.get("/api/stack/projects")
    def projects():
        return stack.projects_info()

    @app.get("/api/stack/projects/folders")
    def project_folders(path: str = ""):
        return stack.list_project_dirs(path)

    @app.post("/api/stack/projects")
    async def set_projects(request: Request):
        return stack.set_projects(await body(request))

    @app.post("/api/stack/apply")
    def apply_projects():
        return stack.apply_all()

    @app.post("/api/stack/start")
    async def stack_start(request: Request):
        return stack.start_all((await body(request)).get("build"))

    @app.post("/api/stack/stop")
    def stack_stop():
        return stack.stop_all()

    # Integrator · Gateway (registered before the generic /{component} routes)
    @app.get("/api/stack/gateway/configs")
    def gw_configs():
        return {"directory": str(stack.config_dir), "found": stack.config_dir.is_dir(), "configs": stack.config_entries(),
                "credentials": stack.credential_status()}

    @app.post("/api/stack/gateway/configs/validate")
    async def gw_validate(request: Request):
        data = await body(request)
        return stack.validate(data.get("config"), bool(data.get("replace")))

    @app.post("/api/stack/gateway/configs/install")
    async def gw_install(request: Request):
        data = await body(request)
        return stack.install(data.get("config"), force=bool(data.get("force")), replace=bool(data.get("replace")))

    @app.delete("/api/stack/gateway/configs/{file}")
    def gw_remove(file: str):
        return stack.remove_config(file)

    @app.get("/api/stack/gateway/presets")
    def gw_presets():
        return stack.presets()

    @app.get("/api/stack/gateway/presets/{folder}/{file}")
    def gw_preset(folder: str, file: str):
        return stack.preset(folder, file)

    @app.post("/api/stack/gateway/credentials")
    async def gw_credentials(request: Request):
        data = await body(request)
        return stack.set_credential(str(data.get("name", "")), data.get("value"))

    @app.post("/api/stack/gateway/browse")
    async def gw_browse(request: Request):
        return stack.browse(await body(request))

    @app.post("/api/stack/gateway/configs/create")
    async def gw_create(request: Request):
        return stack.create_from_browse(await body(request))

    # Integrator · Gateway protocol plugins (gateway-implementations)
    @app.get("/api/stack/gateway/plugins")
    def gw_plugins():
        return {"installed": stack.plugins.catalogue_entries(), "job": stack.plugins.job_status(), "startFolder": stack.plugins.start_folder()}

    @app.get("/api/stack/folders")
    def folders(path: str = ""):
        return stack.plugins.list_dirs(path)

    @app.post("/api/stack/gateway/plugins/inspect")
    async def gw_plugin_inspect(request: Request):
        return stack.plugins.inspect((await body(request)).get("path", ""))

    @app.post("/api/stack/gateway/plugins/install")
    async def gw_plugin_install(request: Request):
        return stack.plugins.install((await body(request)).get("path", ""))

    @app.get("/api/stack/files")
    def files(path: str = "", accept: str = ""):
        return stack.plugins.list_entries(path, [a.strip() for a in accept.split(",") if a.strip()])

    # Service runtime plugins (runtime-plugins) and service packages
    @app.get("/api/stack/runtime/plugins")
    def rt_plugins():
        return {"installed": stack.runtime_plugins.catalogue_entries(), "job": stack.runtime_plugins.job_status(),
                "startFolder": stack.runtime_plugins.start_folder(), "docker": bool(stack.packager.docker()),
                "categories": list(RUNTIME_CATEGORY_NAMES)}

    @app.get("/api/stack/runtime/folders")
    def rt_folders(path: str = ""):
        return stack.runtime_plugins.list_dirs(path)

    @app.post("/api/stack/runtime/plugins/inspect")
    async def rt_plugin_inspect(request: Request):
        return stack.runtime_plugins.inspect((await body(request)).get("path", ""))

    @app.post("/api/stack/runtime/plugins/upload")
    async def rt_plugin_upload(request: Request):
        data = await body(request)
        return stack.runtime_plugins.save_upload(data.get("filename", ""), data.get("contentBase64", ""))

    @app.post("/api/stack/runtime/plugins/install")
    async def rt_plugin_install(request: Request):
        return stack.runtime_plugins.install((await body(request)).get("path", ""))

    @app.delete("/api/stack/runtime/plugins/{plugin_id}")
    def rt_plugin_uninstall(plugin_id: str):
        plugin = next((p for p in stack.runtime_plugins.installed() if p["id"] == plugin_id or p["key"] == plugin_id), None)
        refs = []
        if plugin:
            try:
                refs = [s["serviceId"] for s in (stack.svc("/registry/services") or []) if s.get("technologyAdapter") == plugin.get("adapter")]
            except HTTPException:
                refs = []
        return stack.runtime_plugins.uninstall(plugin_id, refs)

    @app.post("/api/stack/services/prepare")
    async def svc_prepare(request: Request):
        return stack.packager.start(await body(request))

    @app.get("/api/stack/services/prepare/{job_id}")
    def svc_prepare_status(job_id: str):
        return stack.packager.status(job_id)

    # Generic address-space explorer (MQTT topic tree, OPC UA node tree)
    @app.post("/api/stack/explore")
    async def explore_start(request: Request):
        return stack.explorer.start(await body(request))

    @app.get("/api/stack/explore/{session_id}")
    def explore_snapshot(session_id: str):
        return stack.explorer.snapshot(session_id)

    @app.delete("/api/stack/explore/{session_id}")
    def explore_stop(session_id: str):
        return stack.explorer.stop(session_id)

    @app.delete("/api/stack/gateway/plugins/{plugin_id}")
    def gw_plugin_uninstall(plugin_id: str):
        plugin = next((p for p in stack.plugins.installed() if p["id"] == plugin_id or p["key"] == plugin_id), None)
        refs = [e["machineId"] for e in stack.config_entries() if plugin and e.get("protocol") == plugin["protocol"]]
        return stack.plugins.uninstall(plugin_id, refs)

    # Integrator · Engine rules in the AASX
    @app.get("/api/stack/engine/rules")
    def aasx_rules():
        return {**stack.aasx.info(), "rules": stack.aasx.rules() if stack.aasx.path.is_file() else [], "conditions": ENGINE_CONDITIONS}

    @app.post("/api/stack/engine/rules")
    async def aasx_add(request: Request):
        stack.require_config_unlocked()
        return stack.aasx.add(await body(request))

    @app.put("/api/stack/engine/rules/{rule_id}")
    async def aasx_update(rule_id: str, request: Request):
        stack.require_config_unlocked()
        return stack.aasx.update(rule_id, await body(request))

    @app.delete("/api/stack/engine/rules/{rule_id}")
    def aasx_delete(rule_id: str):
        stack.require_config_unlocked()
        return stack.aasx.delete(rule_id)

    @app.post("/api/stack/engine/aasx/verify")
    def aasx_verify():
        return stack.aasx.verify()

    @app.post("/api/stack/engine/aasx/backup")
    def aasx_backup():
        return stack.aasx.backup()

    # Operator · Engine
    @app.post("/api/stack/engine/initialize")
    def eng_init():
        return {"message": stack.engine_text("/engine/startup")}

    @app.post("/api/stack/engine/shutdown")
    def eng_shutdown():
        return {"message": stack.engine_text("/engine/shutdown")}

    @app.get("/api/stack/engine/state")
    def eng_state():
        return {"state": stack.engine_text("/engine/state"), "runtime": stack.engine_runtime_state()}

    @app.get("/api/stack/engine/history")
    def eng_history():
        return {"history": stack.engine_text("/engine/history")}

    @app.get("/api/stack/engine/submodel-data")
    def eng_data():
        return {"data": stack.engine_text("/engine/submodel-data")}

    @app.post("/api/stack/engine/push")
    async def eng_push(request: Request):
        return stack.push(await body(request))

    # Integrator + Operator · Services
    @app.get("/api/stack/services")
    def svc_list(response: Response):
        if stack.catalog is not None:
            items, source = stack.catalog.list()
            response.headers["X-Labradt-Source"] = source
            return items
        items = stack.svc("/registry/services")
        if isinstance(items, list) and stack.services_listener:
            stack.services_listener(items)
        return items

    @app.post("/api/stack/services")
    async def svc_register(request: Request):
        return stack.register_service(await body(request))

    @app.get("/api/stack/services/executions")
    def svc_executions():
        running = stack.svc("/services/running") or []
        history = sorted(stack.svc("/services/history") or [], key=lambda r: r.get("completedAt") or 0, reverse=True)
        return {"running": running, "history": history}

    @app.post("/api/stack/services/trigger")
    async def svc_trigger(request: Request):
        data = await body(request)
        ids = [str(x) for x in (data.get("serviceIds") or []) if str(x).strip()]
        if not ids:
            raise HTTPException(400, "Select at least one service")
        args = {str(k): str(v) for k, v in (data.get("dynamicArgs") or {}).items()}
        return stack.svc("/services/trigger", "POST", {"serviceIds": ids, "dynamicArgs": args})

    @app.get("/api/stack/services/status")
    def svc_status(execution_id: str = Query(alias="executionId")):
        return stack.svc("/services/status?executionId=" + urllib.parse.quote(execution_id, safe=""))

    @app.get("/api/stack/services/result")
    def svc_result(execution_id: str = Query(alias="executionId")):
        return stack.svc("/services/result?executionId=" + urllib.parse.quote(execution_id, safe=""))

    @app.post("/api/stack/services/stop")
    def svc_stop(execution_id: str = Query(alias="executionId")):
        return stack.svc("/services/stop?executionId=" + urllib.parse.quote(execution_id, safe=""), "POST")

    @app.get("/api/stack/services/{service_id}")
    def svc_get(service_id: str):
        if stack.catalog is not None:
            return stack.catalog.get(service_id)
        return stack.svc("/registry/services/" + urllib.parse.quote(service_id, safe=""))

    @app.delete("/api/stack/services/{service_id}")
    def svc_delete(service_id: str, force: bool = False):
        return stack.delete_service(service_id, force)

    # Operator · component processes
    @app.post("/api/stack/{component}/start")
    async def comp_start(component: str, request: Request):
        return stack.component(component).start((await body(request)).get("build"))

    @app.post("/api/stack/{component}/stop")
    def comp_stop(component: str):
        return stack.component(component).stop()

    @app.post("/api/stack/{component}/force-stop")
    def comp_force_stop(component: str):
        return stack.component(component).force_stop()

    @app.get("/api/stack/{component}/logs")
    def comp_logs(component: str, lines: int = 300):
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse(stack.component(component).logs(lines))

    @app.get("/api/stack/{component}")
    def comp_status(component: str):
        return stack.component(component).status()
