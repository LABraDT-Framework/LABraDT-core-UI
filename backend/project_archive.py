"""Project export / import: one self-contained .zip with everything configured in the UI.

Layout of the archive:

    labradt-project.json                manifest (format, version, created, counts)
    gateway/configs/<machine>.json      machine configs of the Gateway (also gateway/configs/.disabled/)
    engine/aasx/<name>.aasx             the Engine's rules AASX
    engine/storage/<key>.json           service files in the Engine storage (scripts, Dockerfiles, packed folders)
    runtime/services.json               service definitions of the registry (instances)
    ui/workspace.json                   UI workspace: bindings, service metadata (backend-config.json)
                                        (the AASX also holds the AAS of the project: aasx/labradt/environment.json)
    plugins/gateway/<key>/...           installed Gateway plugins (plugin.json + lib/*.jar)
    plugins/runtime/<key>/...           installed runtimes (service plugins)

Import writes everything into the chosen projects (configs into the gateway project, AASX and storage into the
engine project, runtime/config/services.json into the runtime project, consumed at its next start) and into the
UI's plugin stores, then hands the plugins over to the projects. The three components must be stopped.
"""
from __future__ import annotations

import io
import json
import shutil
import time
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from fastapi import HTTPException, Request
from fastapi.responses import Response

FORMAT, VERSION = "labradt-project", 1
MANIFEST = "labradt-project.json"
AAS_KINDS = ("concept-descriptions", "submodels", "shells")  # import order: references point "up"
MAX_ARCHIVE = 512 * 1024 * 1024


def _safe(name: str) -> PurePosixPath:
    """An archive member path that cannot escape its target folder."""
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise HTTPException(422, f"Unsafe path in the archive: {name}")
    return path


class ProjectArchive:
    def __init__(self, stack: Any, store_path: Path, aasx: Any, catalog: Any):
        """aasx: project_model.EngineAasx (AAS in the engine AASX); catalog: project_model.ServiceCatalog."""
        self.stack, self.store_path, self.aasx, self.catalog = stack, Path(store_path), aasx, catalog

    # -- helpers -------------------------------------------------------------------
    def storage_dir(self) -> Path:
        return self.stack.engine_dir / "storage"  # engine.storage.path=storage, relative to the engine project

    def services(self) -> tuple[list[dict[str, Any]], str]:
        """Service instances: the live registry, or what the runtime project holds while the Runtime is stopped."""
        return self.catalog.list()

    def remember_services(self, items: list[dict[str, Any]]) -> None:
        self.catalog.remember(items)

    def require_stopped(self) -> None:
        running = [c.label for c in self.stack.components.values() if c.alive() or c.health()]
        if running:
            raise HTTPException(409, "Stop the stack before importing a project (running: " + ", ".join(running) + ").")

    # -- export ----------------------------------------------------------------------
    def export(self) -> tuple[bytes, str]:
        buffer = io.BytesIO()
        counts: dict[str, Any] = {}
        notes: list[str] = []
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            configs = self.stack.config_dir
            files = sorted(configs.glob("*.json")) + sorted((configs / ".disabled").glob("*.json")) if configs.is_dir() else []
            for f in files:
                archive.write(f, "gateway/configs/" + f.relative_to(configs).as_posix())
            counts["gatewayConfigs"] = len(files)

            aas_sync = self.aasx.sync()  # repository → AASX first, so the AASX holds every AAS
            if aas_sync.get("state") == "pending":
                notes.append("The AAS repository was not running: the AAS come from the engine project's AASX.")
            aasx = self.stack.aasx.path
            if aasx.is_file():
                archive.write(aasx, "engine/aasx/" + aasx.name)
            counts["aasx"] = aasx.name if aasx.is_file() else None

            services, source = self.services()
            archive.writestr("runtime/services.json", json.dumps(services, indent=2))
            counts["services"], counts["servicesFrom"] = len(services), source
            if source == "project":
                notes.append("The Runtime was not running: services come from the runtime project.")
            storage = self.storage_dir()
            refs = {s.get("fileReference") for s in services if s.get("fileReference")}
            stored = 0
            for ref in sorted(refs):
                f = storage / (ref + ".json")
                if f.is_file():
                    archive.write(f, "engine/storage/" + _safe(ref + ".json").as_posix())
                    stored += 1
            counts["serviceFiles"] = stored

            if self.store_path.is_file():
                archive.write(self.store_path, "ui/workspace.json")

            environment = self.aasx.environment()
            counts["aas"] = {k: len(v) for k, v in environment.items()}

            for which, store in (("gateway", self.stack.plugins), ("runtime", self.stack.runtime_plugins)):
                names = []
                for plugin in store.installed():
                    home = store.store / plugin["key"]
                    archive.write(home / "plugin.json", f"plugins/{which}/{plugin['key']}/plugin.json")
                    for name in plugin.get("jars", []):
                        if (home / "lib" / name).is_file():
                            archive.write(home / "lib" / name, f"plugins/{which}/{plugin['key']}/lib/{name}")
                    technology = "/".join(x for x in (plugin.get("category"), plugin.get("adapter")) if x)
                    names.append(technology if which == "runtime" and technology else plugin.get("protocol") or plugin["key"])
                counts[f"{which}Plugins"] = names

            manifest = {"format": FORMAT, "version": VERSION, "createdAt": datetime.now().isoformat(timespec="seconds"),
                        "projects": {k: Path(str(v)).name for k, v in (("engine", self.stack.engine_dir), ("gateway", self.stack.gateway_dir), ("runtime", self.stack.runtime_dir))},
                        "contents": counts, "notes": notes}
            archive.writestr(MANIFEST, json.dumps(manifest, indent=2))
        return buffer.getvalue(), f"labradt-project-{datetime.now():%Y%m%d-%H%M}.zip"


    # -- import ----------------------------------------------------------------------
    def inspect(self, data: bytes) -> dict[str, Any]:
        archive = self._open(data)
        with archive:
            return json.loads(archive.read(MANIFEST))

    def _open(self, data: bytes) -> zipfile.ZipFile:
        if len(data) > MAX_ARCHIVE:
            raise HTTPException(413, "The project archive is larger than 512 MB.")
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
            manifest = json.loads(archive.read(MANIFEST))
        except (zipfile.BadZipFile, KeyError, ValueError) as error:
            raise HTTPException(422, "Not a LABraDT project archive (labradt-project.json missing).") from error
        if manifest.get("format") != FORMAT or manifest.get("version") != VERSION:
            raise HTTPException(422, f"Unsupported project archive ({manifest.get('format')} v{manifest.get('version')}).")
        for name in archive.namelist():
            _safe(name)
        return archive

    def import_(self, data: bytes) -> dict[str, Any]:
        archive = self._open(data)
        self.require_stopped()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = self.stack.state_dir / "backups" / f"before-import-{stamp}"
        report: dict[str, Any] = {"backup": str(backup), "notes": []}
        with archive:
            names = archive.namelist()
            manifest = json.loads(archive.read(MANIFEST))

            # Gateway machine configs: replace the project's configs (old ones go to the backup)
            configs = self.stack.config_dir
            if configs.is_dir():
                for f in list(configs.glob("*.json")) + list((configs / ".disabled").glob("*.json")):
                    dest = backup / "gateway-configs" / f.relative_to(configs)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(f), dest)
            written = 0
            for name in names:
                if name.startswith("gateway/configs/") and name.endswith(".json"):
                    dest = configs / _safe(name[len("gateway/configs/"):])
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(archive.read(name))
                    written += 1
            report["gatewayConfigs"] = written

            # Engine: rules AASX (into the current AASX path) and the service files of the storage
            aasx_members = [n for n in names if n.startswith("engine/aasx/") and n.endswith(".aasx")]
            if aasx_members:
                target = self.stack.aasx.path
                if target.is_file():
                    (backup / "engine").mkdir(parents=True, exist_ok=True)
                    shutil.copy2(target, backup / "engine" / target.name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(aasx_members[0]))
                report["aasx"] = str(target)
            storage, stored = self.storage_dir(), 0
            for name in names:
                if name.startswith("engine/storage/") and not name.endswith("/"):
                    dest = storage / _safe(name[len("engine/storage/"):])
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(archive.read(name))
                    stored += 1
            report["serviceFiles"] = stored

            # Runtime: the service instances, registered at the Runtime's next start (replacing the registry)
            services = json.loads(archive.read("runtime/services.json")) if "runtime/services.json" in names else []
            seed = self.stack.runtime_dir / "config" / "services.json"
            seed.parent.mkdir(parents=True, exist_ok=True)
            seed.write_text(json.dumps({"replace": True, "services": services}, indent=2), encoding="utf-8")
            self.remember_services(services)
            report["services"] = len(services)

            # UI workspace (bindings, service metadata)
            if "ui/workspace.json" in names:
                if self.store_path.is_file():
                    backup.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(self.store_path, backup / "workspace.json")
                self.store_path.parent.mkdir(parents=True, exist_ok=True)
                self.store_path.write_bytes(archive.read("ui/workspace.json"))
                report["workspace"] = True

            # Plugins: replace the UI's plugin stores, then hand them over to the projects
            for which, store in (("gateway", self.stack.plugins), ("runtime", self.stack.runtime_plugins)):
                prefix = f"plugins/{which}/"
                keys = sorted({PurePosixPath(n[len(prefix):]).parts[0] for n in names if n.startswith(prefix) and len(PurePosixPath(n[len(prefix):]).parts) > 1})
                if store.store.is_dir():
                    for old in store.store.iterdir():
                        if old.is_dir() and not old.name.startswith("_"):
                            dest = backup / f"{which}-plugins" / old.name
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            shutil.move(str(old), dest)
                for key in keys:
                    home = store.store / _safe(key)
                    for name in names:
                        if name.startswith(prefix + key + "/") and not name.endswith("/"):
                            dest = home / _safe(name[len(prefix + key + "/"):])
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            dest.write_bytes(archive.read(name))
                    plugin_json = home / "plugin.json"
                    if plugin_json.is_file():  # loaded at the next start after this import
                        plugin = json.loads(plugin_json.read_text(encoding="utf-8"))
                        plugin["installedAt"] = time.time()
                        plugin_json.write_text(json.dumps(plugin, indent=2), encoding="utf-8")
                report[f"{which}Plugins"] = keys
            report["applied"] = self.stack.apply_all()

            # AAS: they came with the AASX; archives of earlier versions carry them in aas/environment.json
            if "aas/environment.json" in names and self.stack.aasx.path.is_file():
                legacy = json.loads(archive.read("aas/environment.json"))
                for kind in AAS_KINDS:
                    for model in legacy.get(kind) or legacy.get({"shells": "assetAdministrationShells", "submodels": "submodels", "concept-descriptions": "conceptDescriptions"}[kind]) or []:
                        self.aasx.put(kind, model)
            report["aas"] = self.aasx.sync()  # into the repository now, or at the next Start Stack / Apply
            report["manifest"] = manifest
        return report


def install_project_archive(app: Any, archive: ProjectArchive) -> None:
    @app.get("/api/project/export")
    def export_project():
        data, name = archive.export()
        return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    @app.post("/api/project/inspect")
    async def inspect_project(request: Request):
        return archive.inspect(await request.body())

    @app.post("/api/project/import")
    async def import_project(request: Request):
        return archive.import_(await request.body())

    @app.post("/api/project/aas/sync")
    def sync_aas():
        return archive.aasx.sync()
