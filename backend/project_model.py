"""Project-first persistence: what the pages configure always lands in the three component projects.

The Services, Rules and AAS pages used to write only to the running servers (Service Manager, Engine storage,
AAS repository), so nothing was kept when a component was stopped, and the System page (which reads the project
files) showed something else. This module puts the projects first:

* ServiceCatalog - service instances. Live registry when the Runtime runs; otherwise the desired list is kept in
  <runtime project>/config/services.json ({"replace": true, "services": [...]}), which the Runtime registers at its
  next start (ServiceImportFile). Service files go to <engine project>/storage/ directly when the Engine is down.
* EngineAasx - AAS (shells, submodels, concept descriptions) in the engine project's AASX, as an extra JSON part
  next to the Engine's own XML (rules, state chart): aasx/labradt/environment.json. Written on every change; pushed
  to the AAS repository when that is reachable (on change, at Start Stack and with Apply to Projects).
* RulesPageSync - rules of the Rules page that the Engine can run (one watched value of the Engine's data submodel
  with >, < or =, constant or same-submodel arguments, no output mapping) are written into Rules_SM of the engine
  AASX and marked executor=engine; the UI controller runs only the others (executor=ui).
"""
from __future__ import annotations

import copy
import json
import os
import re
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote

from fastapi import HTTPException

ENV_KEYS = {"shells": "assetAdministrationShells", "submodels": "submodels", "concept-descriptions": "conceptDescriptions"}
RESERVED = {"Rules_SM", "StateChart_SM", "CPS_SM"}  # Engine-owned submodels (repository_proxy.RESERVED)
ENGINE_DATA_SUBMODELS = {"CPS_SM", "CPS-SM"}       # the Engine's telemetry channel: rules on it run in the Engine
JSON_PART = "aasx/labradt/environment.json"
SPEC_REL = "http://admin-shell.io/aasx/relationships/aas-spec"
OPERATORS = {">": "greater_than", "<": "less_than", "=": "equals", "==": "equals"}


# ─────────────────────────────────────────────────────────────────────────────
# Services
# ─────────────────────────────────────────────────────────────────────────────

class ServiceCatalog:
    def __init__(self, stack: Any, snapshot: Path):
        self.stack, self.snapshot = stack, Path(snapshot)
        self.lock = threading.RLock()

    def live(self) -> bool:
        return self.stack.components["runtime"].health()

    @property
    def pending_file(self) -> Path:
        return self.stack.runtime_dir / "config" / "services.json"

    def _pending(self) -> list[dict[str, Any]] | None:
        try:
            data = json.loads(self.pending_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data.get("services", []) if isinstance(data, dict) else data if isinstance(data, list) else None

    def remember(self, items: list[dict[str, Any]]) -> None:
        try:
            self.snapshot.parent.mkdir(parents=True, exist_ok=True)
            self.snapshot.write_text(json.dumps(items, indent=2), encoding="utf-8")
        except OSError:
            pass

    def list(self) -> tuple[list[dict[str, Any]], str]:
        """(definitions, source): source is 'runtime' (live registry) or 'project' (kept in the runtime project)."""
        if self.live():
            try:
                items = self.stack.svc("/registry/services")
                if isinstance(items, list):
                    self.remember(items)
                    return items, "runtime"
            except HTTPException:
                pass
        pending = self._pending()
        if pending is not None:
            return pending, "project"
        try:
            return json.loads(self.snapshot.read_text(encoding="utf-8")), "project"
        except (OSError, ValueError):
            return [], "project"

    def get(self, service_id: str) -> dict[str, Any]:
        item = next((s for s in self.list()[0] if s.get("serviceId") == service_id), None)
        if item is None:
            raise HTTPException(404, f"Service '{service_id}' not found")
        return item

    def _write_pending(self, items: list[dict[str, Any]]) -> None:
        self.pending_file.parent.mkdir(parents=True, exist_ok=True)
        self.pending_file.write_text(json.dumps({"replace": True, "services": items}, indent=2), encoding="utf-8")
        self.remember(items)

    def upsert(self, definition: dict[str, Any]) -> dict[str, Any]:
        service_id = definition["serviceId"]
        with self.lock:
            if self.live():
                from .stack import http
                exists = any(s.get("serviceId") == service_id for s in self.list()[0])
                path = "/registry/services" + ("/" + _quote(service_id) if exists else "")
                status, body = http(self.stack.services_url + path, "PUT" if exists else "POST", definition)
                if status >= 400 or (isinstance(body, dict) and body.get("error")):
                    raise HTTPException(status if status >= 400 else 422, (body.get("message") if isinstance(body, dict) else body) or "Registration failed")
                self.list()  # refresh the snapshot
                return {"saved": service_id, "where": "runtime", "definition": body if isinstance(body, dict) else definition}
            items = [s for s in self.list()[0] if s.get("serviceId") != service_id] + [definition]
            self._write_pending(items)
            return {"saved": service_id, "where": "project", "definition": definition,
                    "message": "The Runtime is stopped: saved in the runtime project (config/services.json); registered at its next start."}

    def delete(self, service_id: str) -> dict[str, Any]:
        with self.lock:
            items = self.list()[0]
            if not any(s.get("serviceId") == service_id for s in items):
                raise HTTPException(404, f"Service '{service_id}' not found")
            if self.live():
                from .stack import http
                status, body = http(self.stack.services_url + "/registry/services/" + _quote(service_id), "DELETE")
                if status >= 400:
                    raise HTTPException(status, f"Delete failed (HTTP {status}): {body}")
                self.list()
                return {"deleted": service_id, "where": "runtime"}
            self._write_pending([s for s in items if s.get("serviceId") != service_id])
            return {"deleted": service_id, "where": "project"}


def _quote(value: str) -> str:
    import urllib.parse
    return urllib.parse.quote(value, safe="")


def store_service_file(engine_dir: Path, filename: str, data: bytes, key: str | None = None) -> str:
    """Writes a service file into the engine project's storage the way the Engine's /engine/storage/upload does."""
    name = Path(filename or "upload.bin").name
    stem = name.rsplit(".", 1)[0] if "." in name else name
    key = (key or f"services/{uuid.uuid4()}-{stem}").strip("/")
    root = (Path(engine_dir) / "storage").resolve()
    target = (root / (key.replace("/", os.sep) + ".json")).resolve()
    if not str(target).startswith(str(root)):
        raise HTTPException(400, "Invalid storage key")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(data.decode("utf-8"), encoding="utf-8")
    return key


# ─────────────────────────────────────────────────────────────────────────────
# AAS in the engine project's AASX
# ─────────────────────────────────────────────────────────────────────────────

class EngineAasx:
    """AAS environment kept as a JSON part of the engine AASX (aasx/labradt/environment.json)."""

    def __init__(self, stack: Any, repository: dict[str, Callable] | None = None):
        """repository: {"reachable": fn() -> bool, "collection": fn(kind), "put": fn(kind, model), "delete": fn(kind, id)}"""
        self.stack, self.repository = stack, repository

    @property
    def path(self) -> Path:
        return self.stack.aasx.path

    @property
    def lock(self) -> threading.RLock:
        return self.stack.aasx.lock

    def repository_live(self) -> bool:
        try:
            return bool(self.repository and self.repository["reachable"]())
        except Exception:
            return False

    # -- the JSON part ----------------------------------------------------------
    def read(self) -> dict[str, Any]:
        with self.lock:
            if not self.path.is_file():
                return {"assetAdministrationShells": [], "submodels": [], "conceptDescriptions": [], "labradt": {"deleted": []}}
            with zipfile.ZipFile(self.path) as archive:
                data = json.loads(archive.read(JSON_PART)) if JSON_PART in archive.namelist() else {}
        for key in ENV_KEYS.values():
            data.setdefault(key, [])
        data.setdefault("labradt", {}).setdefault("deleted", [])
        return data

    def write(self, data: dict[str, Any]) -> None:
        if not self.path.is_file():
            raise HTTPException(404, f"The engine AASX was not found: {self.path}. Choose the engine project on the System page.")
        payload = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
        with self.lock:
            tmp = self.path.with_name(self.path.name + ".tmp")
            try:
                with zipfile.ZipFile(self.path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
                    names = zin.namelist()
                    for item in zin.infolist():
                        if item.filename == JSON_PART:
                            continue
                        content = zin.read(item.filename)
                        if item.filename == "[Content_Types].xml" and b'Extension="json"' not in content:
                            default = b'<Default Extension="json" ContentType="application/json" />'
                            content = content.replace(b"</Types>", default + b"</Types>") if b"</Types>" in content \
                                else re.sub(rb"<Types([^>]*)/>", lambda m: b"<Types" + m.group(1) + b">" + default + b"</Types>", content)
                        if item.filename == "aasx/_rels/aasx-origin.rels" and JSON_PART.encode() not in content:
                            content = content.replace(b"</Relationships>", f'<Relationship Type="{SPEC_REL}" Target="/{JSON_PART}" Id="rLabradtEnvironment" /></Relationships>'.encode())
                        zout.writestr(item, content)
                    zout.writestr(JSON_PART, payload)
                    if "[Content_Types].xml" not in names:
                        zout.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json" /></Types>')
                os.replace(tmp, self.path)
            except Exception as error:
                tmp.unlink(missing_ok=True)
                raise HTTPException(500, f"Could not write the engine AASX: {error}") from error

    # -- models -------------------------------------------------------------------
    def environment(self) -> dict[str, list]:
        data = self.read()
        return {key: data[key] for key in ENV_KEYS.values()}

    def collection(self, kind: str) -> list[dict[str, Any]]:
        return self.read()[ENV_KEYS[kind]]

    def get(self, kind: str, identifier: str) -> dict[str, Any]:
        model = next((m for m in self.collection(kind) if m.get("id") == identifier), None)
        if model is None:
            raise HTTPException(404, f"{kind[:-1]} '{identifier}' is not in the engine project")
        return model

    def put(self, kind: str, model: dict[str, Any]) -> None:
        if kind == "submodels" and model.get("idShort") in RESERVED:
            return  # Engine-owned: lives in the Engine's own part of the AASX
        with self.lock:
            data = self.read()
            items = data[ENV_KEYS[kind]]
            data[ENV_KEYS[kind]] = [m for m in items if m.get("id") != model["id"]] + [copy.deepcopy(model)]
            data["labradt"]["deleted"] = [d for d in data["labradt"]["deleted"] if d.get("id") != model["id"]]
            self.write(data)

    def delete(self, kind: str, identifier: str, *, remember: bool) -> None:
        with self.lock:
            data = self.read()
            data[ENV_KEYS[kind]] = [m for m in data[ENV_KEYS[kind]] if m.get("id") != identifier]
            if kind == "submodels":
                for shell in data["assetAdministrationShells"]:
                    shell["submodels"] = [ref for ref in shell.get("submodels", []) if not any(k.get("value") == identifier for k in ref.get("keys", []))]
            if remember:  # deleted while the repository was down: delete it there at the next sync
                data["labradt"]["deleted"].append({"kind": kind, "id": identifier})
            self.write(data)

    def submodel(self, identifier: str) -> dict[str, Any] | None:
        return next((m for m in self.collection("submodels") if m.get("id") == identifier), None)

    def submodel_or_repository(self, identifier: str) -> dict[str, Any] | None:
        """A submodel by id: the repository first (it also holds the Engine's live CPS_SM), else the project."""
        if self.repository_live():
            try:
                return next((m for m in self.repository["collection"]("submodels") if m.get("id") == identifier), None) or self.submodel(identifier)
            except Exception:
                pass
        return self.submodel(identifier)

    # -- sync with the AAS repository --------------------------------------------
    def ensure_synced(self) -> None:
        """Syncs once whenever the repository comes up (it starts empty, or with older content)."""
        live = self.repository_live()
        if live and not getattr(self, "_synced", False):
            self._synced = True
            try:
                self.sync()
            except Exception:
                self._synced = False
        elif not live:
            self._synced = False

    def sync(self) -> dict[str, Any]:
        """Pushes the project's AAS to the repository; adopts repository-only (non Engine) models into the project."""
        if not self.path.is_file():
            return {"state": "skipped", "message": "engine AASX not found"}
        if not self.repository_live():
            return {"state": "pending", "message": "The AAS repository is not reachable; the AAS stay in the engine AASX and are written when it is."}
        data = self.read()
        pushed, adopted, removed, failed = 0, 0, 0, []
        for item in list(data["labradt"]["deleted"]):
            try:
                self.repository["delete"](item["kind"], item["id"])
                removed += 1
            except Exception as error:
                if getattr(error, "status_code", None) != 404:
                    failed.append(f"delete {item['id']}: {getattr(error, 'detail', error)}")
        for kind in ("concept-descriptions", "submodels", "shells"):
            for model in data[ENV_KEYS[kind]]:
                try:
                    self.repository["put"](kind, model)
                    pushed += 1
                except Exception as error:
                    failed.append(f"{kind} {model.get('id')}: {getattr(error, 'detail', error)}")
            known = {m.get("id") for m in data[ENV_KEYS[kind]]}
            try:
                for model in self.repository["collection"](kind):
                    if model.get("id") not in known and not (kind == "submodels" and model.get("idShort") in RESERVED) \
                            and not (kind == "shells" and _engine_shell(model, data, self.repository)):
                        data[ENV_KEYS[kind]].append(model)
                        adopted += 1
            except Exception as error:
                failed.append(f"read {kind}: {getattr(error, 'detail', error)}")
        if not failed:
            data["labradt"]["deleted"] = []
        if adopted or removed:
            self.write(data)
        return {"state": "done" if not failed else "partial", "pushed": pushed, "adopted": adopted, "removed": removed, "failed": failed}


def _engine_shell(shell: dict[str, Any], data: dict[str, Any], repository: dict[str, Callable]) -> bool:
    """A shell that only holds Engine-owned submodels (created by the Engine itself) is not adopted."""
    refs = {k.get("value") for ref in shell.get("submodels", []) for k in ref.get("keys", [])}
    if not refs:
        return False
    try:
        reserved = {m.get("id") for m in repository["collection"]("submodels") if m.get("idShort") in RESERVED}
    except Exception:
        return False
    return refs <= reserved


# ─────────────────────────────────────────────────────────────────────────────
# Rules page → Engine rules in the AASX
# ─────────────────────────────────────────────────────────────────────────────

class RulesPageSync:
    SOURCE = "rules-page:"

    def __init__(self, stack: Any, submodel_lookup: Callable[[str], dict[str, Any] | None]):
        self.stack, self.submodel_lookup = stack, submodel_lookup

    @staticmethod
    def _identity(property_id: str) -> tuple[str, str]:
        parts = [unquote(p) for p in str(property_id).split("|")]
        if len(parts) != 3:
            raise ValueError("unknown SME reference")
        return parts[1], parts[2]

    def convert(self, rule: dict[str, Any]) -> tuple[dict[str, str] | None, str]:
        """(engine rule properties, reason). None when the Engine cannot run this rule."""
        monitors = rule.get("monitors") or []
        if len(monitors) != 1:
            return None, "several conditions"
        monitor = monitors[0]
        operator = str(monitor.get("condition", {}).get("operator", ""))
        if operator not in OPERATORS:
            return None, f"operator {operator} (the Engine knows >, < and =)"
        if (rule.get("output") or {}).get("kind") not in (None, "", "none"):
            return None, "writes its result to an AAS property"
        try:
            submodel_id, path = self._identity(monitor.get("propertyId", ""))
        except ValueError:
            return None, "unknown SME reference"
        submodel = self.submodel_lookup(submodel_id) or {}
        id_short = submodel.get("idShort", "")
        if id_short not in ENGINE_DATA_SUBMODELS or "." in path:
            return None, "watches a value outside the Engine's data submodel (CPS_SM)"
        call = rule.get("serviceCall") or {}
        if not call.get("serviceId"):
            return None, "no service"
        parameters = {}
        for name, binding in (call.get("bindings") or {}).items():
            if binding.get("source") == "constant":
                parameters[name] = (binding.get("value") or {}).get("value") if isinstance(binding.get("value"), dict) else binding.get("value")
            elif binding.get("source") == "property":
                try:
                    sm, p = self._identity(binding.get("propertyId", ""))
                except ValueError:
                    return None, "argument from an unknown SME"
                if sm != submodel_id or "." in p:
                    return None, "argument from another submodel"
                parameters[name] = {"input": p}
            else:
                return None, "unsupported argument"
        right = monitor.get("condition", {}).get("right", {})
        props = {"targetSubmodel": id_short, "targetElement": path, "condition": OPERATORS[operator],
                 "threshold": str(right.get("value") if isinstance(right, dict) else right), "action": call["serviceId"],
                 "description": rule.get("name") or rule.get("id"), "enabled": "true" if rule.get("enabled", True) else "false",
                 "source": self.SOURCE + str(rule.get("id"))}
        if parameters:
            props["parameters"] = json.dumps(parameters, separators=(",", ":"))
        return props, ""

    def sync(self, rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Writes the Engine-capable rules into the AASX and returns the rules marked with executor / engineRule."""
        aasx = self.stack.aasx
        try:
            existing = {r.get("source", "")[len(self.SOURCE):]: r for r in aasx.rules() if str(r.get("source", "")).startswith(self.SOURCE)}
        except HTTPException:
            existing = None  # no AASX: everything stays in the UI
        marked = []
        for rule in rules:
            rule = dict(rule)
            props, reason = self.convert(rule) if existing is not None else (None, "the engine AASX was not found")
            rid = str(rule.get("id"))
            if props:
                current = existing.pop(rid, None)
                if current:
                    changes = {k: v for k, v in props.items() if current.get(k) != v}
                    if changes:
                        aasx.update(current["id"], changes)
                    rule["engineRule"] = current["id"]
                else:
                    rule["engineRule"] = aasx.add(props)["id"]
                rule["executor"], rule["executorReason"] = "engine", ""
            else:
                rule["executor"], rule["executorReason"] = "ui", reason
                rule.pop("engineRule", None)
            marked.append(rule)
        for leftover in (existing or {}).values():  # rule deleted on the Rules page, or no longer Engine-capable
            try:
                aasx.delete(leftover["id"])
            except HTTPException:
                pass
        return marked
