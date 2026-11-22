import sys
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree as ET

UI = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(UI), str(UI / '.python-packages')]
from fastapi import HTTPException
from fastapi import FastAPI
from backend import repository_proxy as repository
from backend import aas_proxy
from scripts.prepare_aas import RESOURCES


def isolate_project_hooks(test):
    """These tests cover the modules alone: undo the project-first hooks that importing backend.app installs."""
    from backend import backend_workspace, repository_proxy, runtime_proxy
    saved = {(m, n): getattr(m, n) for m, n in ((backend_workspace, "CATALOG"), (backend_workspace, "RULES_SYNC"), (repository_proxy, "LOCAL"),
                                               (runtime_proxy, "CATALOG"), (runtime_proxy, "SERVICE_REFERENCES"))}
    for (m, n) in saved:
        setattr(m, n, None)
    test.addCleanup(lambda: [setattr(m, n, v) for (m, n), v in saved.items()])

class RepositoryTests(unittest.TestCase):
    def setUp(self):
        isolate_project_hooks(self)

    def test_delete_submodel_detaches_all_shells_and_preserves_other_references(self):
        app = FastAPI()
        repository.install_repository_proxy(app, 'http://test')
        delete = next(route.endpoint for route in app.routes if route.path == '/api/aas/models/{kind}' and 'DELETE' in route.methods)
        target = {'id': 'urn:custom', 'idShort': 'Custom'}
        ref = lambda identifier: {'type':'ModelReference','keys':[{'type':'Submodel','value':identifier}]}
        shells = [{'id':'urn:a','submodels':[ref('urn:custom'),ref('urn:keep')]}, {'id':'urn:b','submodels':[ref('urn:custom')]}]
        with patch.object(repository, 'call', return_value=target) as transport, patch.object(repository, 'collection', return_value=shells):
            self.assertEqual(delete('submodels','urn:custom').status_code,204)
            writes = [call.args for call in transport.call_args_list if len(call.args) > 2]
            self.assertEqual([args[2] for args in writes], ['PUT','PUT','DELETE'])
            self.assertEqual(writes[0][3]['submodels'],[ref('urn:keep')])
            self.assertEqual(writes[1][3]['submodels'],[])

    def test_revision_is_stable_across_object_key_order(self):
        self.assertEqual(repository.revision({'id':'urn:test','value':{'b':2,'a':1}}), repository.revision({'value':{'a':1,'b':2},'id':'urn:test'}))
        self.assertNotEqual(repository.revision({'value':'1'}), repository.revision({'value':'2'}))

    def test_stale_editor_never_writes(self):
        old = {'id':'urn:test','idShort':'Custom','value':'old'}
        new = {**old,'value':'other writer'}
        with patch.object(repository, 'call', return_value=new) as transport:
            with self.assertRaises(HTTPException) as error: repository.update_model('http://test','submodels','urn:test',old,repository.revision(old))
            self.assertEqual(error.exception.status_code,412)
            self.assertEqual(transport.call_count,1)

    def test_matching_revision_writes_complete_model(self):
        old = {'id':'urn:test','idShort':'Custom','qualifiers':[{'value':'preserved'}]}
        new = {**old,'description':[{'language':'en','text':'New description'}]}
        with patch.object(repository, 'call', return_value=old) as transport:
            repository.update_model('http://test','submodels','urn:test',new,repository.revision(old))
            self.assertEqual(transport.call_args.args[-2:],('PUT',new))

    def test_conditional_update_does_not_bypass_engine_guard(self):
        old = {'id':'urn:test','idShort':'CPS_SM'}
        with patch.object(repository, 'call', return_value=old) as transport:
            with self.assertRaises(HTTPException) as error: repository.update_model('http://test','submodels','urn:test',old,repository.revision(old))
            self.assertEqual(error.exception.status_code,409)
            self.assertEqual(transport.call_count,1)

    def test_active_shell_references_cannot_be_detached(self):
        old = {'id':'urn:shell','idShort':'Shell','assetInformation':{},'submodels':[{'keys':[{'type':'Submodel','value':'urn:cps'}]}]}
        with patch.object(repository, 'call', return_value=old), patch.object(repository,'collection',return_value=[{'id':'urn:cps','idShort':'CPS_SM'}]):
            with self.assertRaises(HTTPException) as error: repository.update_model('http://test','shells','urn:shell',{**old,'submodels':[]},repository.revision(old))
            self.assertEqual(error.exception.status_code,409)

    def test_nested_idshort_validation(self):
        with self.assertRaises(HTTPException) as error:
            repository.validate({'id':'urn:test', 'idShort':'Valid', 'submodelElements':[{'idShort':'Not-Valid'}]}, 'submodels')
        self.assertEqual(error.exception.status_code, 400)

    def test_full_metadata_not_rewritten(self):
        model = {'id':'urn:test', 'idShort':'Valid', 'semanticId':{'type':'ExternalReference','keys':[{'value':'urn:test:sem'}]}}
        repository.validate(model, 'submodels')
        self.assertEqual(model['semanticId']['keys'][0]['value'], 'urn:test:sem')

    def test_pagination(self):
        with patch.object(repository, 'call', side_effect=[{'result':[{'id':'a'}],'paging_metadata':{'cursor':'next'}}, {'result':[{'id':'b'}]}]):
            self.assertEqual([m['id'] for m in repository.collection('http://test','shells')], ['a','b'])

    def test_repeated_cursor(self):
        with patch.object(repository, 'call', return_value={'result':[],'paging_metadata':{'cursor':'same'}}):
            with self.assertRaises(HTTPException): repository.collection('http://test','shells')

    def test_engine_submodel_protected(self):
        with patch.object(repository, 'call', return_value={'id':'urn:rules','idShort':'Rules_SM'}):
            with self.assertRaises(HTTPException) as error: repository.guarded_model('http://test','submodels','urn:rules')
            self.assertEqual(error.exception.status_code,409)

    def test_basyx_numeric_values_use_lexical_strings(self):
        with patch.object(aas_proxy, '_request', side_effect=[(200,b'{"modelType":"Property","valueType":"xs:double"}','application/json'),(204,b'','application/json')]) as transport:
            aas_proxy.patch_value('http://test','urn:test','Nested.Value',16.5)
            self.assertEqual(transport.call_args.args[2],b'"16.5"')

    def test_basyx_read_converts_using_declared_type(self):
        with patch.object(aas_proxy, '_request', side_effect=[(200,b'"16.5"','application/json'),(200,b'{"modelType":"Property","valueType":"xs:double"}','application/json')]):
            self.assertEqual(aas_proxy.get_value('http://test','urn:test','Value').body,b'16.5')

    def test_basyx_rejects_invalid_numeric_value(self):
        with patch.object(aas_proxy, '_request', return_value=(200,b'{"modelType":"Property","valueType":"xs:double"}','application/json')):
            with self.assertRaises(HTTPException) as error: aas_proxy.patch_value('http://test','urn:test','Value','NaN')
            self.assertEqual(error.exception.status_code,400)

    def test_prepared_global_ids_and_references_preserved(self):
        ns = {'aas':'https://admin-shell.io/aas/3/0'}
        for name in ('MachineTool.aasx', 'Molder.aasx'):
            with self.subTest(package=name):
                if not (UI / 'data/repository' / name).is_file(): self.skipTest('Blank canvas: no AAS seed packages; run scripts.prepare_aas to create them')
                with zipfile.ZipFile(RESOURCES / name) as original, zipfile.ZipFile(UI / 'data/repository' / name) as prepared:
                    self.assertEqual(original.namelist(), prepared.namelist())
                    for entry in original.namelist():
                        if not entry.endswith('.aas.xml'): continue
                        before, after = ET.fromstring(original.read(entry)), ET.fromstring(prepared.read(entry))
                        for selector in ('.//aas:id', './/aas:keys/aas:key/aas:value'):
                            self.assertEqual([e.text for e in before.findall(selector,ns)], [e.text for e in after.findall(selector,ns)])
                        self.assertTrue(all('-' not in e.text for e in after.findall('.//aas:idShort',ns)))

if __name__ == '__main__': unittest.main()
