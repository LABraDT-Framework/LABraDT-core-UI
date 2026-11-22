import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from backend import backend_lifecycle as lifecycle

class LifecycleTests(unittest.TestCase):
    def test_configuration_and_manual_mutations_require_stopped(self):
        for path,method in [('/api/aas/models/submodels','POST'),('/api/aas/models/shells','PUT'),('/api/aas/models/concept-descriptions','DELETE'),('/api/engine/rules/Rule_1','PUT'),('/api/gateway/configs/cnc-line1','PUT'),('/api/gateway/configs/cnc-line1','DELETE'),('/api/services/registry','POST'),('/api/services/trigger','POST'),('/api/aas/value','PATCH'),('/api/gateway/live/value/cnc.Temp','PATCH'),('/api/process/gateway/stop','POST')]:
            self.assertTrue(lifecycle.requires_stopped(path,method),path)
    def test_readonly_browse_and_parser_remain_available(self):
        for path,method in [('/api/aas/environment','GET'),('/api/engine/rules','GET'),('/api/services/status','GET'),('/api/gateway/discover/opcua','POST'),('/api/gateway/configs/validate','POST'),('/api/aas/templates/parse','POST')]:
            self.assertFalse(lifecycle.requires_stopped(path,method),path)
    def test_plugin_and_connection_lifecycle_require_stopped(self):
        for path, method in [('/api/gateway/plugins','POST'),('/api/gateway/plugins/plugin:test','DELETE'),('/api/gateway/configs/machine/enabled','PATCH')]:
            self.assertTrue(lifecycle.requires_stopped(path,method))
        self.assertFalse(lifecycle.requires_stopped('/api/gateway/plugins/inspect','POST'))
    def test_gateway_checks_loaded_bytes_not_a_process_local_dirty_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'machine.json'
            # Unit-test fixture only; no repository/configuration file is modified.
            raw = b'{"machineId":"machine"}'
            path.write_bytes(raw)
            loaded = {'files':{'machine.json':hashlib.sha256(raw).hexdigest()},'errors':[]}
            with patch.object(lifecycle,'get_json',side_effect=[JSONResponse(loaded),JSONResponse({'status':'UP'})]):
                self.assertTrue(lifecycle.gateway_preflight('http://gateway/api/submodel/health',Path(directory),lambda *a,**k:[])['configurationLoaded'])
            with patch.object(lifecycle,'get_json',return_value=JSONResponse({**loaded,'files':{}})):
                with self.assertRaises(HTTPException) as error: lifecycle.gateway_preflight('http://gateway/api/submodel/health',Path(directory),lambda *a,**k:[])
                self.assertEqual(error.exception.status_code,409)
    def test_rejected_gateway_file_blocks_start(self):
        with patch.object(lifecycle,'get_json',return_value=JSONResponse({'files':{},'errors':['invalid file']})):
            with self.assertRaises(HTTPException) as error: lifecycle.gateway_preflight('http://gateway/api/submodel/health',Path('.'),lambda *a,**k:[])
            self.assertEqual(error.exception.status_code,422)
