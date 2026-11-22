"""Gateway package catalogue and recoverable machine configuration lifecycle.

Uploaded code is staged, never executed by the Python controller. The Java
Gateway loads compatible plugins at its next restart and reports actual beans.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import threading
import time
import zipfile
from pathlib import Path

from fastapi import HTTPException, Request
from .gateway_proxy import get_json, gateway_base
from .opcua_setup import public_config, credentials

DESCRIPTOR = 'META-INF/guc-gateway-plugin.json'
IMPORTS = 'META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports'
PROTOCOLS = {'OPC_UA', 'MQTT', 'MODBUS', 'DDS', 'PROFINET'}
# The gateway project ships no protocol adapter; OPC UA, MQTT, ... are separate plugins
# (gateway-implementations). List protocols that are compiled into your Gateway build in
# GATEWAY_BUNDLED_PROTOCOLS (e.g. "OPC_UA,MQTT"); by default the catalogue starts empty.
_BUNDLED_NAMES = {'OPC_UA': 'OPC UA', 'MQTT': 'MQTT'}
BUILTINS = [dict(id='plugin:' + p, name=_BUNDLED_NAMES.get(p, p), protocol=p, version='bundled')
            for p in (x.strip().upper() for x in os.getenv('GATEWAY_BUNDLED_PROTOCOLS', '').split(',')) if p in PROTOCOLS]
ID = re.compile(r'plugin:[A-Za-z0-9_-]{1,80}$')
MACHINE = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,127}$')
CLASS = re.compile(r'(?:[A-Za-z_$][A-Za-z0-9_$]*\.)+[A-Za-z_$][A-Za-z0-9_$]*$')


def atomic(path: Path, raw: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.pending')
    temp.write_bytes(raw)
    os.replace(temp, path)


def inspect_jar(raw: bytes, filename: str) -> dict:
    if not filename.lower().endswith('.jar') or not 0 < len(raw) <= 25 * 1024 * 1024:
        raise HTTPException(422, 'Select a compatible .jar package, at most 25 MiB.')
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) > 3000 or sum(item.file_size for item in entries) > 128 * 1024 * 1024:
                raise ValueError('Package expansion limit exceeded')
            names = [item.filename for item in entries]
            if len(set(names)) != len(names) or any(item.flag_bits & 1 or item.filename.startswith(('/', '\\')) or '\\' in item.filename or '..' in item.filename.split('/') for item in entries):
                raise ValueError('Duplicate, encrypted or unsafe archive entry')
            if any(name.startswith(('BOOT-INF/', 'org/springframework/', 'com/guc/dt_framework/')) for name in names):
                raise ValueError('Use a library JAR; do not bundle the Gateway/Spring framework or an executable Boot application')
            if archive.getinfo(DESCRIPTOR).file_size > 16000 or archive.getinfo(IMPORTS).file_size > 16000:
                raise ValueError('Descriptor too large')
            data = json.loads(archive.read(DESCRIPTOR))
            if not isinstance(data, dict): raise ValueError('Descriptor must be a JSON object')
            if data.get('schemaVersion') != 1 or not ID.fullmatch(str(data.get('id', ''))):
                raise ValueError('Invalid descriptor schemaVersion or plugin: ID')
            if data.get('protocol') not in PROTOCOLS or not all(isinstance(data.get(k), str) and 0 < len(data[k]) <= 128 for k in ('name', 'version')):
                raise ValueError('Declare a supported protocol, name and version')
            if data['protocol'] in {item['protocol'] for item in BUILTINS}:
                raise ValueError(data['protocol'] + ' is bundled with this Gateway; replacing its driver is not supported')
            classes = ('adapterClass', 'translatorClass', 'configurationClass')
            for key in classes:
                name = str(data.get(key, ''))
                if not CLASS.fullmatch(name) or name.replace('.', '/') + '.class' not in names:
                    raise ValueError('Missing valid compiled class: ' + key)
            registered = {line.strip() for line in archive.read(IMPORTS).decode().splitlines() if line.strip() and not line.lstrip().startswith('#')}
            if data['configurationClass'] not in registered:
                raise ValueError('configurationClass must be registered in Spring AutoConfiguration.imports')
            # Never forward arbitrary Java/system properties from an uploaded package.
            enabled = data.get('enabledProperty')
            if enabled and not re.fullmatch(r'dt\.adapter\.[a-z][a-z0-9-]{0,40}\.enabled', enabled):
                raise ValueError('Invalid adapter enabledProperty')
            return {key: data[key] for key in ('schemaVersion', 'id', 'name', 'version', 'protocol', *classes, 'enabledProperty') if key in data} | {'sha256': hashlib.sha256(raw).hexdigest(), 'filename': Path(filename).name, 'size': len(raw)}
    except (ValueError, KeyError, zipfile.BadZipFile, UnicodeError, TypeError) as error:
        raise HTTPException(422, 'Not a compatible Gateway plugin: ' + str(error)) from error


class GatewayManagement:
    def __init__(self, configs, plugins, health, validate, references=None, host_jar='/opt/plugin-host/target/gateway-plugin-host-0.9.1.jar', java_plugins='/gateway-plugins'):
        self.configs, self.plugins = Path(configs), Path(plugins)
        self.health, self.validate = health, validate
        self.reference_reader = references or (lambda machine: [])
        self.host_jar, self.java_plugins = host_jar, java_plugins
        self.lock = threading.RLock()
        # Protocol plugins built from gateway-implementations by the stack controller (backend/stack.py).
        self.project_plugins = lambda: []

    def path(self, machine, disabled=False):
        if not MACHINE.fullmatch(machine): raise HTTPException(400, 'Invalid Machine ID')
        return self.configs / ('.disabled' if disabled else '') / (machine + '.json')

    def entries(self):
        result = []
        for disabled in (False, True):
            directory = self.configs / '.disabled' if disabled else self.configs
            for path in sorted(directory.glob('*.json')):
                data = json.loads(path.read_text(encoding='utf-8'))
                result.append({'fileName': path.name, 'config': public_config(data), 'enabled': not disabled})
        return result

    def locate(self, machine):
        active, disabled = self.path(machine), self.path(machine, True)
        if active.exists() and disabled.exists(): raise HTTPException(409, 'Duplicate active/disabled configuration; inspect files before editing')
        if active.exists(): return active, True
        if disabled.exists(): return disabled, False
        raise HTTPException(404, 'Machine connection not found')

    def installed(self):
        result = []
        for path in sorted(self.plugins.glob('*/descriptor.json')):
            if (path.parent / '.uninstalled').exists(): continue
            result.append(json.loads(path.read_text(encoding='utf-8')))
        return result

    def runtime(self):
        try:
            return json.loads(get_json(gateway_base(self.health), '/api/plugins').body)
        except HTTPException:
            # This Gateway has no JAR plugin host; it is available when it answers its health check.
            try:
                get_json(gateway_base(self.health), '/api/submodel/health')
                return {'available': True, 'plugins': [], 'host': False, 'message': ''}
            except HTTPException:
                return {'available': False, 'plugins': [], 'message': 'Gateway is not running. Start it on the System page.'}

    def catalogue(self):
        runtime = self.runtime()
        loaded = {item['id']: item for item in runtime.get('plugins', [])}
        entries = self.entries()
        plugins = []
        projects = self.project_plugins()
        desired = BUILTINS + self.installed()
        for item in projects:
            refs = [{'machineId': entry['config']['machineId'], 'enabled': entry['enabled']} for entry in entries if entry['config']['protocol'] == item['protocol']]
            plugins.append({**item, 'references': refs})
        for item in desired:
            actual = loaded.get(item['id'])
            matches = actual and (item.get('sha256') is None or actual.get('sha256') == item['sha256'])
            state = actual.get('status', 'Unavailable') if matches else 'Restart required' if runtime.get('available') else 'Unavailable'
            refs = [{'machineId': entry['config']['machineId'], 'enabled': entry['enabled']} for entry in entries if entry['config']['protocol'] == item['protocol']]
            plugins.append({**item, 'source': 'bundled' if item in BUILTINS else 'installed', 'status': state, 'references': refs, 'message': actual.get('message', '') if matches else 'Apply staged changes by restarting Gateway.'})
        removed = [dict(item, source='removed', status='Removal pending restart', references=[]) for item in runtime.get('plugins', []) if item['id'] not in {p['id'] for p in desired + projects}]
        return {'plugins': plugins + removed, 'runtimeAvailable': bool(runtime.get('available')), 'restartRequired': any(p['status'] in {'Restart required', 'Removal pending restart'} for p in plugins + removed), 'message': runtime.get('message', '')}

    def loader(self):
        installed = self.installed()
        lines = ['loader.system=true', 'loader.path=' + ','.join([self.host_jar] + [self.java_plugins + '/' + item['id'][7:] + '/plugin.jar' for item in installed])]
        lines += [item['enabledProperty'] + '=true' for item in installed if item.get('enabledProperty')]
        atomic(self.plugins / 'loader.properties', ('\n'.join(lines) + '\n').encode())

    def install(self, raw, filename):
        descriptor = inspect_jar(raw, filename)
        with self.lock:
            if any(item['id'] == descriptor['id'] or item['protocol'] == descriptor['protocol'] for item in BUILTINS + self.installed() + self.project_plugins()):
                raise HTTPException(409, 'Plugin ID or protocol already installed. Remove the old plugin after removing its machine references.')
            folder = self.plugins / descriptor['id'][7:]
            if (folder / '.uninstalled').exists() and any(p.get('id') == descriptor['id'] for p in self.runtime().get('plugins', [])):
                raise HTTPException(409, 'Finish the pending uninstall by restarting Gateway before reinstalling this plugin')
            try: atomic(folder / 'plugin.jar', raw)
            except OSError as error: raise HTTPException(409, 'Plugin JAR is still in use or not writable. Restart Gateway and check folder permissions before retrying.') from error
            atomic(folder / 'descriptor.json', json.dumps(descriptor, indent=2).encode())
            (folder / '.uninstalled').unlink(missing_ok=True)
            self.loader()
        return {'plugin': descriptor, 'restartRequired': True}

    def uninstall(self, plugin):
        with self.lock:
            item = next((item for item in self.installed() if item['id'] == plugin), None)
            if item is None: raise HTTPException(409, 'Bundled plugins are protected, or plugin is not installed')
            refs = [entry['config']['machineId'] for entry in self.entries() if entry['config']['protocol'] == item['protocol']]
            if refs: raise HTTPException(409, {'message': 'Remove all machine connections using this plugin first (including disabled connections).', 'references': refs})
            source = self.plugins / plugin[7:]
            archive = self.plugins / '.removed' / (plugin[7:] + '-' + str(time.time_ns()))
            # Windows bind mounts cannot rename a directory containing a JVM-open JAR.
            # Archive a readable copy and retire it via a marker; never delete live code.
            atomic(archive / 'plugin.jar', (source / 'plugin.jar').read_bytes())
            atomic(archive / 'descriptor.json', (source / 'descriptor.json').read_bytes())
            atomic(source / '.uninstalled', json.dumps({'archive': archive.name}).encode())
            self.loader()
        return {'removed': plugin, 'recoverable': True, 'restartRequired': True}

    def save(self, machine, payload):
        with self.lock:
            if payload.get('machineId') != machine: raise HTTPException(400, 'URL and configuration Machine ID must match')
            payload = dict(payload)
            try: path, enabled = self.locate(machine)
            except HTTPException as error:
                if error.status_code != 404: raise
                path, enabled = self.path(machine), True
            saved = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
            if isinstance(payload.get('connection'), dict):
                payload['connection'] = credentials(payload['connection'], saved.get('connection') if saved.get('protocol') == payload.get('protocol') else None)
            errors = self.validate(payload, existing_ids={e['config']['machineId'] for e in self.entries() if e['config']['machineId'] != machine})
            if errors: raise HTTPException(422, ' '.join(errors))
            plugin_missing = payload['protocol'] not in {p['protocol'] for p in BUILTINS + self.installed() + self.project_plugins()}
            atomic(path, (json.dumps(payload, indent=2, ensure_ascii=False) + '\n').encode())
            result = {'valid': True, 'fileName': path.name, 'enabled': enabled, 'restartRequired': enabled}
            if plugin_missing: result['warning'] = 'No ' + payload['protocol'] + ' Gateway plugin is listed; add it before the Gateway can connect.'
            return result

    def references(self, machine):
        self.locate(machine)
        return self.reference_reader(machine)

    def enable(self, machine, enabled):
        if type(enabled) is not bool: raise HTTPException(422, 'enabled must be boolean')
        with self.lock:
            source, previous = self.locate(machine)
            refs = self.reference_reader(machine)
            if enabled != previous:
                target = self.path(machine, not enabled)
                target.parent.mkdir(parents=True, exist_ok=True)
                source.rename(target)
            return {'enabled': enabled, 'restartRequired': enabled != previous, 'references': refs, 'message': 'Dependent mappings/rules are retained; Start validation may require this connection to be enabled.' if refs and not enabled else ''}

    def delete(self, machine):
        with self.lock:
            source, enabled = self.locate(machine)
            refs = self.reference_reader(machine)
            if refs: raise HTTPException(409, {'message': 'Unlink dependent AAS mappings and remove dependent rules before deleting this connection.', 'references': refs})
            target = self.configs / '.deleted' / (machine + '-' + str(time.time_ns()) + '.json')
            target.parent.mkdir(parents=True, exist_ok=True)
            source.rename(target)
            return {'deleted': machine, 'recoverable': True, 'restartRequired': enabled}


def install_management(app, manager):
    app.state.gateway_management = manager
    async def read_package(request):
        chunks = []; size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > 25 * 1024 * 1024: raise HTTPException(413, 'Plugin package exceeds 25 MiB')
            chunks.append(chunk)
        return b''.join(chunks)
    @app.get('/api/gateway/plugins')
    def plugins(): return manager.catalogue()

    @app.post('/api/gateway/plugins/inspect')
    async def inspect(request: Request, filename: str):
        return inspect_jar(await read_package(request), filename)

    @app.post('/api/gateway/plugins')
    async def install(request: Request, filename: str, confirm: bool = False):
        if not confirm: raise HTTPException(400, 'Confirm that this trusted Java plugin may execute code in Gateway')
        return manager.install(await read_package(request), filename)

    @app.delete('/api/gateway/plugins/{plugin_id}')
    def uninstall(plugin_id: str): return manager.uninstall(plugin_id)

    @app.get('/api/gateway/configs/{machine_id}/references')
    def references(machine_id: str): return {'references': manager.references(machine_id)}

    @app.patch('/api/gateway/configs/{machine_id}/enabled')
    def enabled(machine_id: str, payload: dict): return manager.enable(machine_id, payload.get('enabled'))

    @app.get('/api/gateway/management/status')
    def status():
        result = manager.catalogue()
        project = os.getenv('GUC_COMPOSE_PROJECT', 'ui_v09')
        service = os.getenv('GUC_GATEWAY_SERVICE', 'gateway')
        if os.getenv('GUC_COMPOSE_PROJECT') and re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project) and service in ('gateway', 'demo-gateway'):
            result['restartCommand'] = f'docker compose -p {project} restart {service}'
        else:
            result['restartCommand'] = 'System page → Components → Gateway: Stop, then Start'
        try:
            loaded = json.loads(get_json(gateway_base(manager.health), '/api/submodel/configuration').body)
            desired = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in manager.configs.glob('*.json')}
            result['configurationLoaded'] = not loaded.get('errors') and loaded.get('files') == desired
            result['restartRequired'] |= not result['configurationLoaded']
        except HTTPException:
            result['configurationLoaded'] = False
        return result
