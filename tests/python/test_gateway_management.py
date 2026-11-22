import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from backend import gateway_management as module

def package(**changes):
    data = dict(schemaVersion=1, id='plugin:test', name='Test', version='1', protocol='MODBUS', adapterClass='org.example.Adapter', translatorClass='org.example.Translator', configurationClass='org.example.Configuration', enabledProperty='dt.adapter.modbus.enabled')
    data.update(changes)
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, 'w') as archive:
        archive.writestr(module.DESCRIPTOR, json.dumps(data))
        archive.writestr(module.IMPORTS, data['configurationClass'])
        for key in ('adapterClass', 'translatorClass', 'configurationClass'): archive.writestr(data[key].replace('.', '/') + '.class', b'fixture')
    return raw.getvalue()

class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.references = []
        self.manager = module.GatewayManagement(self.root/'configs', self.root/'plugins', 'http://gateway/api/submodel/health', lambda *a, **kw: [], lambda machine: self.references)
        self.config = {'machineId': 'test-machine', 'protocol': 'OPC_UA', 'connection': {'endpoint': 'opc.tcp://mock'}, 'mappings': [{'idShort': 'Temperature'}]}
    def test_package_descriptor_and_hash(self):
        raw = package(); result = module.inspect_jar(raw, 'test.jar')
        self.assertEqual(result['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(result['protocol'], 'MODBUS')
    def test_reject_ordinary_jars_invalid_identity_and_enabled_properties(self):
        for raw in (b'PKnotajar', package(id='plugin:../escape'), package(enabledProperty='java.security.manager')):
            with self.assertRaises(HTTPException) as error: module.inspect_jar(raw, 'test.jar')
            self.assertEqual(error.exception.status_code, 422)
        # Blank canvas: nothing is bundled, so an MQTT plugin package is accepted ...
        self.assertEqual(module.inspect_jar(package(protocol='MQTT'), 'test.jar')['protocol'], 'MQTT')
        # ... unless MQTT is declared as bundled (GATEWAY_BUNDLED_PROTOCOLS).
        with patch.object(module, 'BUILTINS', [dict(id='plugin:MQTT', name='MQTT', protocol='MQTT', version='bundled')]):
            with self.assertRaises(HTTPException): module.inspect_jar(package(protocol='MQTT'), 'test.jar')
    def test_unsafe_or_missing_classes_rejected(self):
        for name in ('../escape.class', 'org/springframework/Shadow.class'):
            raw = io.BytesIO(package())
            with zipfile.ZipFile(raw, 'a') as archive: archive.writestr(name, b'fixture')
            with self.assertRaises(HTTPException): module.inspect_jar(raw.getvalue(), 'test.jar')
    def test_install_is_staged_until_actual_jvm_status_matches(self):
        raw = package(); self.manager.install(raw, 'test.jar')
        with patch.object(self.manager, 'runtime', return_value={'available': True, 'plugins': []}):
            self.assertTrue(self.manager.catalogue()['restartRequired'])
        actual = {'available': True, 'plugins': [{'id': 'plugin:test', 'status': 'Loaded', 'sha256': hashlib.sha256(raw).hexdigest()}]}
        with patch.object(self.manager, 'runtime', return_value=actual):
            self.assertEqual(self.manager.catalogue()['plugins'][-1]['status'], 'Loaded')
        self.assertIn('dt.adapter.modbus.enabled=true', (self.root/'plugins/loader.properties').read_text())
        with self.assertRaises(HTTPException): self.manager.install(raw, 'test.jar')
    def test_enable_disable_preserves_exact_bytes_and_links(self):
        self.manager.save('test-machine', self.config)
        raw = self.manager.path('test-machine').read_bytes(); self.references.append({'id': 'aas-one'})
        disabled = self.manager.enable('test-machine', False)
        self.assertEqual(disabled['references'], self.references)
        self.assertEqual(self.manager.path('test-machine', True).read_bytes(), raw)
        self.assertFalse(self.manager.entries()[0]['enabled'])
        self.manager.save('test-machine', self.config)
        self.assertFalse(self.manager.entries()[0]['enabled'])
        self.manager.enable('test-machine', True)
        self.assertEqual(self.manager.path('test-machine').read_bytes(), raw)
    def test_deletion_is_reference_protected_and_recoverable(self):
        self.manager.save('test-machine', self.config); self.references.append({'id': 'rule-one'})
        with self.assertRaises(HTTPException) as error: self.manager.delete('test-machine')
        self.assertEqual(error.exception.status_code, 409)
        self.references.clear(); result = self.manager.delete('test-machine')
        self.assertTrue(result['recoverable']); self.assertEqual(self.manager.entries(), [])
        self.assertEqual(len(list((self.root/'configs/.deleted').glob('test-machine-*.json'))), 1)
    def test_uninstall_protects_disabled_connections_and_builtins(self):
        self.manager.install(package(), 'test.jar'); self.config['protocol'] = 'MODBUS'
        self.manager.save('test-machine', self.config); self.manager.enable('test-machine', False)
        with self.assertRaises(HTTPException): self.manager.uninstall('plugin:test')
        with self.assertRaises(HTTPException): self.manager.uninstall('plugin:OPC_UA')
        self.manager.delete('test-machine'); self.manager.uninstall('plugin:test')
        self.assertEqual(self.manager.installed(), [])
        self.assertEqual(len(list((self.root/'plugins/.removed').glob('test-*'))), 1)
        self.assertTrue((self.root/'plugins/test/plugin.jar').exists())
        self.assertTrue((self.root/'plugins/test/.uninstalled').exists())
        with patch.object(self.manager, 'runtime', return_value={'plugins':[{'id':'plugin:test'}]}):
            with self.assertRaises(HTTPException): self.manager.install(package(), 'test.jar')
        with patch.object(self.manager, 'runtime', return_value={'plugins':[]}): self.manager.install(package(), 'test.jar')
        self.assertFalse((self.root/'plugins/test/.uninstalled').exists())
    def test_unknown_protocol_and_unsafe_machine_paths_rejected(self):
        self.assertIn('warning', self.manager.save('test-machine', {**self.config, 'protocol': 'DDS'}))  # saved, plugin still missing
        self.assertEqual(module.BUILTINS, [])  # no bundled protocol plugin by default
        with self.assertRaises(HTTPException): self.manager.path('../outside')
        with self.assertRaises(HTTPException): self.manager.enable('test-machine', 'false')
    def test_management_status_compares_loaded_fingerprints(self):
        from fastapi import FastAPI
        app = FastAPI(); module.install_management(app, self.manager)
        status = next(route.endpoint for route in app.routes if route.path == '/api/gateway/management/status')
        self.manager.save('test-machine', self.config)
        files = {'test-machine.json': hashlib.sha256(self.manager.path('test-machine').read_bytes()).hexdigest()}
        with patch.object(self.manager, 'catalogue', return_value={'restartRequired': False}), patch.object(module, 'get_json', return_value=JSONResponse({'files': files, 'errors': []})):
            self.assertTrue(status()['configurationLoaded'])
        with patch.dict(module.os.environ, {'GUC_COMPOSE_PROJECT': 'guc_lab_091', 'GUC_GATEWAY_SERVICE': 'gateway'}), patch.object(self.manager, 'catalogue', return_value={'restartRequired': False}), patch.object(module, 'get_json', return_value=JSONResponse({'files': files, 'errors': []})):
            self.assertEqual(status()['restartCommand'], 'docker compose -p guc_lab_091 restart gateway')
        with patch.object(self.manager, 'catalogue', return_value={'restartRequired': False}), patch.object(module, 'get_json', return_value=JSONResponse({'files': {}, 'errors': []})):
            self.assertTrue(status()['restartRequired'])
