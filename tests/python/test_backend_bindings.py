import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from fastapi import HTTPException
from backend import backend_bindings as module

class BindingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.worker=module.BackendBindings(module.Store(Path(self.temp.name)/'store.json'),'http://aas','http://gateway/api/submodel/health',self.temp.name,lambda _:True)
        self.binding={'id':'test','name':'Test','signalKey':'cnc-line1.SpindleSpeed','submodelId':'urn:test','path':'Telemetry.Speed','valueType':'xs:double','direction':'gateway_to_aas','intervalMs':500,'startupAuthority':'manual','enabled':True}
        self.catalog={'signals':[{'key':self.binding['signalKey'],'valueType':'xs:double','protocol':'OPC_UA'}],'properties':[{'submodelId':'urn:test','path':'Telemetry.Speed','valueType':'xs:double'}]}
        self.patcher=patch.object(self.worker,'catalog',return_value=self.catalog);self.patcher.start();self.addCleanup(self.patcher.stop)
    def test_read_pair_accepts_utc_gateway_timestamps_with_nanoseconds(self):
        from datetime import datetime, timezone, timedelta
        from fastapi.responses import JSONResponse
        def entry(stamp):
            return {self.binding['signalKey']:{'value':'12.5','qualifiers':[{'type':'StatusCode','value':'OK'},{'type':'ObservedAt','value':stamp}]}}
        now=datetime.now(timezone.utc)
        fresh=now.strftime('%Y-%m-%dT%H:%M:%S.')+'123456789Z'
        with patch.object(module.gateway,'get_json',return_value=JSONResponse(entry(fresh))),patch.object(module.aas,'get_value',return_value=JSONResponse(3.0)):
            self.assertEqual(self.worker.read_pair(self.binding),(12.5,3.0))
        old=(now-timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M:%S.')+'123456789Z'
        with patch.object(module.gateway,'get_json',return_value=JSONResponse(entry(old))),patch.object(module.aas,'get_value',return_value=JSONResponse(3.0)):
            with self.assertRaises(HTTPException): self.worker.read_pair(self.binding)
    def test_typed_scalars(self):
        self.assertEqual(module.typed('false','xs:boolean'),False)
        self.assertEqual(module.typed('25.5','xs:double'),25.5)
        for value in ['NaN','Infinity',True]:
            with self.assertRaises(HTTPException):module.typed(value,'xs:double')
    def test_configuration_persists_and_stale_edit_rejected(self):
        self.worker.save([self.binding],0)
        self.assertEqual(module.Store(self.worker.store.path).read()['bindings'],[self.binding])
        with self.assertRaises(HTTPException) as failure:self.worker.save([],0)
        self.assertEqual(failure.exception.status_code,412)
    def test_validation_type_and_competing_writer(self):
        with self.assertRaises(HTTPException):self.worker.validate([{**self.binding,'valueType':'xs:string'}])
        with self.assertRaises(HTTPException):self.worker.validate([self.binding,{**self.binding,'id':'second'}])
    def test_gateway_write_access_is_checked(self):
        self.worker.probe=lambda _:False
        with self.assertRaises(HTTPException):self.worker.validate([{**self.binding,'direction':'aas_to_gateway'}])
    def test_bidirectional_policy(self):
        b={**self.binding,'direction':'bidirectional'}
        self.assertEqual(module.direction(b,None,1,2),'conflict')
        self.assertEqual(module.direction({**b,'startupAuthority':'gateway'},None,1,2),'gateway_to_aas')
        self.assertEqual(module.direction(b,[1,1],2,1),'gateway_to_aas')
        self.assertEqual(module.direction(b,[1,1],1,2),'aas_to_gateway')
        self.assertEqual(module.direction(b,[1,1],2,3),'conflict')
    def test_read_test_does_not_write_and_confirmed_manual_write_does(self):
        self.worker.save([self.binding],0)
        with patch.object(self.worker,'read_pair',return_value=(1500,0)),patch.object(module.aas,'patch_value') as write:
            self.worker.manual('test',False);write.assert_not_called()
            self.worker.manual('test',True);write.assert_called_once_with('http://aas','urn:test','Telemetry.Speed',1500)
    def test_automatic_worker_uses_committed_snapshot_and_stops(self):
        self.worker.save([self.binding],0)
        with patch.object(self.worker,'read_pair',return_value=(1500,0)),patch.object(module.aas,'patch_value') as write:
            prepared=self.worker.prepare({'rules':[]});self.worker.commit_run(prepared,{'runId':'run-1'})
            self.worker.tick({'state':'STOPPED','runId':'run-1'});write.assert_not_called()
            self.worker.tick({'state':'RUNNING','runId':'wrong'});write.assert_not_called()
            self.worker.tick({'state':'RUNNING','runId':'run-1'});self.assertEqual(write.call_count,1)
            self.assertEqual(self.worker.snapshot()['events'][-1]['runId'],'run-1')
            self.worker.stopped();self.assertEqual(self.worker.snapshot()['runSnapshot']['state'],'STOPPED')
    def test_credentials_not_exposed(self):
        self.catalog['signals'][0]['config']={'password':'secret'}
        self.assertNotIn('config',self.worker.public_catalog()['signals'][0])
