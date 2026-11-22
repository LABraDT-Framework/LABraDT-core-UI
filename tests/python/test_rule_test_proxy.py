import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from fastapi.responses import JSONResponse
from backend import runtime_proxy
from backend.backend_lifecycle import requires_stopped

class App:
    def __init__(self): self.routes={}
    def route(self, method, path):
        def register(fn): self.routes[method,path]=fn;return fn
        return register
    def get(self,path): return self.route('GET',path)
    def post(self,path): return self.route('POST',path)
    def put(self,path): return self.route('PUT',path)
    def delete(self,path): return self.route('DELETE',path)

class Request:
    async def json(self): return {'values':{'Temperature':95},'confirm':True,'writeBack':False}

class RuleTestProxyTests(unittest.TestCase):
    def test_test_endpoints_forward_to_engine_without_simulation(self):
        app=App();runtime_proxy.install_runtime_proxy(app,'http://engine','http://services')
        for operation in ['dry-run','test-trigger']:
            with patch.object(runtime_proxy,'forward_json',return_value=JSONResponse({'conditionMet':True})) as transport:
                asyncio.run(app.routes['POST','/api/engine/rules/{rule_id}/'+operation]('Rule_1',Request()))
                self.assertEqual(transport.call_args.args,('http://engine','/engine/rules/Rule_1/'+operation))
                self.assertEqual(transport.call_args.kwargs['method'],'POST')
                self.assertEqual(transport.call_args.kwargs['payload']['values'],{'Temperature':95})
    def test_result_reads_remain_available_running_but_tests_require_stopped(self):
        for operation in ['dry-run','test-trigger']:
            self.assertTrue(requires_stopped('/api/engine/rules/Rule_1/'+operation,'POST'))
        self.assertFalse(requires_stopped('/api/engine/rule-tests/test-id','GET'))
        app=App();runtime_proxy.install_runtime_proxy(app,'http://engine','http://services')
        with patch.object(runtime_proxy,'forward_json',return_value=JSONResponse({'status':'COMPLETED'})) as transport:
            app.routes['GET','/api/engine/rule-tests/{test_id}']('test-id')
            self.assertEqual(transport.call_args.args,('http://engine','/engine/rule-tests/test-id'))
