import io
import json
import sys
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

UI = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(UI))
from fastapi import HTTPException
from basyx.aas import model
from basyx.aas.adapter import aasx
from backend import template_import as importer

def package(write_json=False, with_file=False):
    collection = model.SubmodelElementCollection('Nested', value=[model.Property('Temperature', model.datatypes.Double, 12.5, description=model.MultiLanguageTextType({'en':'Preserve this description'}))])
    first = model.Submodel('urn:guc:template:one', id_short='FirstTemplate', kind=model.ModellingKind.TEMPLATE, submodel_element=[collection])
    second = model.Submodel('urn:guc:template:two', id_short='SecondTemplate', submodel_element=[model.Range('Limits',model.datatypes.Double,0.0,100.0)])
    store = model.DictObjectStore([first,second]); files = aasx.DictSupplementaryFileContainer()
    if with_file:
        files.add_file('/documentation/manual.txt',io.BytesIO(b'Example manual'),'text/plain')
        first.submodel_element.add(model.File('Manual','text/plain','/documentation/manual.txt'))
    stream = io.BytesIO()
    with aasx.AASXWriter(stream) as writer:
        writer.write_all_aas_objects('/aasx/models.json' if write_json else '/aasx/models.xml',store,files,write_json=write_json)
    return stream.getvalue()

class TemplateImportTests(unittest.TestCase):
    def test_xml_package_multiple_submodels_and_nested_metadata(self):
        result = importer.parse_aasx(package())
        self.assertEqual({s['id'] for s in result['submodels']},{'urn:guc:template:one','urn:guc:template:two'})
        first = next(s for s in result['submodels'] if s['idShort']=='FirstTemplate')
        prop = first['submodelElements'][0]['value'][0]
        self.assertEqual(prop['value'],'12.5')
        self.assertEqual(prop['description'][0]['text'],'Preserve this description')

    def test_json_part_package_supported(self):
        self.assertEqual(len(importer.parse_aasx(package(write_json=True))['submodels']),2)

    def test_embedded_files_warn_instead_of_claiming_uploaded(self):
        result = importer.parse_aasx(package(with_file=True))
        self.assertTrue(any('supplementary files' in w for w in result['warnings']))

    def test_project_legacy_relationships_supported_original_unchanged(self):
        from backend.settings import AASX_PATH as path; before = path.read_bytes()
        result = importer.parse_aasx(before)
        self.assertIn('Behavior',{s['idShort'] for s in result['submodels']})
        self.assertTrue(any('Deprecated' in w for w in result['warnings']))
        self.assertEqual(before,path.read_bytes())

    def test_corrupt_archive_rejected(self):
        with self.assertRaises(HTTPException) as error: importer.parse_aasx(b'not a zip archive')
        self.assertEqual(error.exception.status_code,400)

    def test_original_engine_package_short_names_supported_without_rewriting(self):
        from backend.settings import AASX_PATH as path  # engine-labradt-framework/src/main/resources/MachineTool.aasx
        before = path.read_bytes(); result = importer.parse_aasx(before)
        self.assertIn('Rules_SM', {sm['idShort'] for sm in result['submodels']})
        self.assertIn('urn:machinetool:rules-sm', {sm['id'] for sm in result['submodels']})
        self.assertTrue(any('legacy project idShorts' in warning for warning in result['warnings']))
        self.assertEqual(before, path.read_bytes())

    def test_regular_zip_is_not_an_aasx(self):
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as z: z.writestr('fake.json','{}')
        with self.assertRaises(HTTPException): importer.parse_aasx(stream.getvalue())

    def test_archive_limits(self):
        with patch.object(importer,'MAX_UPLOAD',4):
            with self.assertRaises(HTTPException) as error: importer.parse_aasx(b'12345')
            self.assertEqual(error.exception.status_code,413)
        with patch.object(importer,'MAX_EXPANDED',10):
            with self.assertRaises(HTTPException) as error: importer.parse_aasx(package())
            self.assertEqual(error.exception.status_code,413)
        with patch.object(importer,'MAX_ENTRIES',1):
            with self.assertRaises(HTTPException) as error: importer.parse_aasx(package())
            self.assertEqual(error.exception.status_code,413)

    def test_dtd_traversal_and_external_relationships_rejected(self):
        for name,content in [('evil.xml','<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a/>'),('../model.xml','<a/>'),('_rels/.rels','<Relationships><Relationship TargetMode="External" Target="http://example.com" /></Relationships>')]:
            with self.subTest(name=name):
                stream=io.BytesIO()
                with zipfile.ZipFile(stream,'w') as z: z.writestr(name,content)
                with self.assertRaises(HTTPException) as error: importer.parse_aasx(stream.getvalue())
                self.assertEqual(error.exception.status_code,400)

    def test_empty_package_rejected(self):
        stream=io.BytesIO()
        with aasx.AASXWriter(stream) as writer:
            writer.write_all_aas_objects('/aasx/empty.json',model.DictObjectStore(),aasx.DictSupplementaryFileContainer(),write_json=True)
        with self.assertRaises(HTTPException): importer.parse_aasx(stream.getvalue())

if __name__ == '__main__': unittest.main()
