import asyncio
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from test_rule_test_proxy import App
from backend import runtime_proxy


def isolate_project_hooks(test):
    """These tests cover the modules alone: undo the project-first hooks that importing backend.app installs."""
    from backend import backend_workspace, repository_proxy, runtime_proxy
    saved = {(m, n): getattr(m, n) for m, n in ((backend_workspace, "CATALOG"), (backend_workspace, "RULES_SYNC"), (repository_proxy, "LOCAL"),
                                               (runtime_proxy, "CATALOG"), (runtime_proxy, "SERVICE_REFERENCES"))}
    for (m, n) in saved:
        setattr(m, n, None)
    test.addCleanup(lambda: [setattr(m, n, v) for (m, n), v in saved.items()])

class Request:
    def __init__(self,body):self.body=body
    async def json(self):return self.body

class ServiceEditTests(unittest.TestCase):
    def setUp(self):
        isolate_project_hooks(self)
        self.app=App();runtime_proxy.install_runtime_proxy(self.app,'http://engine','http://services')
        self.definition={'serviceId':'custom','executionCategory':'SCRIPT','technologyAdapter':'LUA','defaultArgs':{'testContent':'return value','value':'1'}}
    def test_update_forwards_without_delete_reregister(self):
        with patch.object(runtime_proxy,'forward_json',return_value=JSONResponse(self.definition)) as forward:
            asyncio.run(self.app.routes['PUT','/api/services/registry/{service_id}']('custom',Request(self.definition)))
            self.assertEqual(forward.call_args.kwargs['method'],'PUT')
            self.assertEqual(forward.call_args.args,('http://services','/registry/services/custom'))
    def test_id_and_defaults_validation(self):
        for body in [{**self.definition,'serviceId':'other'},{**self.definition,'defaultArgs':{'value':1}},{**self.definition,'executionCategory':'EXTERNAL'}]:
            with self.assertRaises(HTTPException):asyncio.run(self.app.routes['PUT','/api/services/registry/{service_id}']('custom',Request(body)))
    def test_referenced_service_delete_is_rejected(self):
        with patch.object(runtime_proxy,'forward_json',return_value=JSONResponse([{'action':'first, custom'}])) as forward:
            with self.assertRaises(HTTPException) as failure:self.app.routes['DELETE','/api/services/registry/{service_id}']('custom')
            self.assertEqual(failure.exception.status_code,409);self.assertEqual(forward.call_count,1)
