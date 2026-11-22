import asyncio
import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from backend.backend_bindings import Store
from backend import backend_workspace as module

def rule(mode='AND'):
    return {'id':'rule-one','conditionMode':mode,'enabled':True,'monitors':[
        {'propertyId':'AAS|urn%3Atest|Temperature','condition':{'operator':'>=','right':{'value':'10'}}}],
        'serviceCall':{'serviceId':'average','bindings':{'a':{'source':'property','propertyId':'AAS|urn%3Atest|Temperature'},'b':{'source':'constant','value':'30'}}},
        'output':{'kind':'aas_property','propertyId':'AAS|urn%3Atest|Average'}}


def isolate_project_hooks(test):
    """These tests cover the modules alone: undo the project-first hooks that importing backend.app installs."""
    from backend import backend_workspace, repository_proxy, runtime_proxy
    saved = {(m, n): getattr(m, n) for m, n in ((backend_workspace, "CATALOG"), (backend_workspace, "RULES_SYNC"), (repository_proxy, "LOCAL"),
                                               (runtime_proxy, "CATALOG"), (runtime_proxy, "SERVICE_REFERENCES"))}
    for (m, n) in saved:
        setattr(m, n, None)
    test.addCleanup(lambda: [setattr(m, n, v) for (m, n), v in saved.items()])

class WorkspaceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        isolate_project_hooks(self)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.bindings=SimpleNamespace(store=Store(Path(self.temp.name)/'config.json'),base='http://aas',services='http://services')
        self.workspace=module.Workspace(self.bindings)
        self.property_patch=patch.object(self.workspace,'property',side_effect=lambda identity:('urn:test',identity.split('|')[-1],'xs:double'))
        self.property_patch.start();self.addCleanup(self.property_patch.stop)
        self.repo_patch=patch.object(module.repository,'call',return_value={'idShort':'Telemetry'})
        self.repo_patch.start();self.addCleanup(self.repo_patch.stop)
        self.calls=[]
        def forward(base,path,**options):
            self.calls.append((path,options))
            if path=='/registry/services':return JSONResponse([{'serviceId':'average'}])
            if path=='/services/trigger':return JSONResponse({'triggered':[{'executionId':'exec-one'}]})
            if path.startswith('/services/status'):return JSONResponse({'status':'COMPLETED'})
            if path.startswith('/services/result'):return JSONResponse({'success':True,'outputData':'25'})
            raise AssertionError(path)
        self.forward_patch=patch.object(module,'forward_json',side_effect=forward)
        self.forward_patch.start();self.addCleanup(self.forward_patch.stop)

    def test_metadata_and_rules_persist_without_altering_mappings(self):
        saved=self.workspace.save({'revision':0,'services':{'average':{'operationId':'averageTemperature'}},'rules':[rule()]})
        self.assertEqual(saved['revision'],1)
        self.assertEqual(module.Workspace(self.bindings).snapshot()['rules'],[rule()])
        self.assertEqual(self.bindings.store.read()['bindings'],[])
        with self.assertRaises(HTTPException) as error:self.workspace.save({'revision':0,'services':{},'rules':[]})
        self.assertEqual(error.exception.status_code,412)

    def test_unknown_service_and_engine_output_rejected(self):
        invalid=rule();invalid['serviceCall']['serviceId']='missing'
        with self.assertRaises(HTTPException):self.workspace.validate([invalid])
        with patch.object(module.repository,'call',return_value={'idShort':'CPS_SM'}):
            with self.assertRaises(HTTPException) as error:self.workspace.validate([rule()])
            self.assertEqual(error.exception.status_code,409)

    async def test_real_service_transport_and_typed_output(self):
        with patch.object(self.workspace,'value',return_value=20),patch.object(module.aas,'patch_value') as write:
            result=await self.workspace.execute(rule(),lambda:{'state':'STOPPED'})
        self.assertEqual(result['status'],'Success');write.assert_called_once_with('http://aas','urn:test','Average',25.0)
        trigger=next(options for path,options in self.calls if path=='/services/trigger')
        self.assertEqual(trigger['payload'],{'serviceIds':['average'],'dynamicArgs':{'a':'20','b':'30'}})

    async def test_false_condition_never_triggers_service(self):
        with patch.object(self.workspace,'value',return_value=5):result=await self.workspace.execute(rule(),lambda:{'state':'STOPPED'})
        self.assertEqual(result['status'],'No action');self.assertFalse(any(path=='/services/trigger' for path,_ in self.calls))

    async def test_and_or_match_common_editor(self):
        draft=rule();draft['monitors'].append({'propertyId':'AAS|urn%3Atest|Other','condition':{'operator':'<','right':{'value':'10'}}});draft['output']={'kind':'none'}
        with patch.object(self.workspace,'value',return_value=20):
            self.assertEqual((await self.workspace.execute(draft,lambda:{}))['status'],'No action')
            draft['conditionMode']='OR';self.assertEqual((await self.workspace.execute(draft,lambda:{}))['status'],'Success')

    async def test_stop_during_job_prevents_late_write(self):
        with patch.object(self.workspace,'value',return_value=20),patch.object(module.aas,'patch_value') as write:
            result=await self.workspace.execute(rule(),lambda:{'state':'STOPPED','runId':'run-one'},run_id='run-one')
        self.assertEqual(result['status'],'Paused');write.assert_not_called()
