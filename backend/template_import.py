"""Read-only Submodel template preview. Uploads never modify Repository/Engine."""
from __future__ import annotations
import io
import json
import zipfile
from xml.etree import ElementTree as ET
from pathlib import PurePosixPath
from typing import Any
from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from basyx.aas import model
from basyx.aas.adapter import aasx, json as aas_json

MAX_UPLOAD = 16 * 1024 * 1024
MAX_EXPANDED = 64 * 1024 * 1024
MAX_ENTRIES = 2000

def parse_aasx(data: bytes) -> dict:
    if len(data) > MAX_UPLOAD: raise HTTPException(413, 'Template exceeds the 16 MiB upload limit')
    try:
        normalized = io.BytesIO()
        legacy_relationships = False
        legacy_names = False
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ENTRIES or sum(item.file_size for item in entries) > MAX_EXPANDED:
                raise HTTPException(413, 'AASX archive exceeds safe expanded size / entry limits')
            names = set()
            for entry in entries:
                name = entry.filename.replace('\\', '/')
                if '..' in PurePosixPath(name).parts or entry.flag_bits & 1:
                    raise HTTPException(400, 'Unsafe or encrypted AASX archive entry')
                if name in names: raise HTTPException(400, 'Duplicate AASX archive entry')
                names.add(name)
                if name.lower().endswith(('.xml', '.rels')):
                    xml = archive.read(entry).replace(b'\x00', b'').upper()
                    if b'<!DOCTYPE' in xml or b'<!ENTITY' in xml:
                        raise HTTPException(400, 'DTD / entity declarations are not allowed in template uploads')
            # Some existing project packages use the deprecated www relationship
            # namespace. Normalize only Relationship Type attributes in memory,
            # never alter source packages, model IDs, values or semantic references.
            with zipfile.ZipFile(normalized, 'w') as output:
                for entry in entries:
                    content = archive.read(entry)
                    if entry.filename.lower().endswith('.rels'):
                        relationships = ET.fromstring(content)
                        changed = False
                        for relationship in relationships:
                            if relationship.get('TargetMode', '').lower() == 'external':
                                raise HTTPException(400, 'External package relationships are not supported in template uploads')
                            kind = relationship.get('Type', '')
                            if kind.startswith('http://www.admin-shell.io/aasx/relationships/'):
                                relationship.set('Type', kind.replace('http://www.admin-shell.io/', 'http://admin-shell.io/', 1))
                                changed = legacy_relationships = True
                        if changed: content = ET.tostring(relationships, encoding='utf-8', xml_declaration=True)
                    elif entry.filename.lower().endswith('.xml'):
                        document = ET.fromstring(content)
                        # This endpoint previews Submodels, not Shells or CDs.
                        # An unrelated malformed Shell must not hide valid templates.
                        if document.tag in ('{https://admin-shell.io/aas/3/0}environment', '{https://admin-shell.io/aas/3/0}aas'):
                            removed = False
                            for child in list(document):
                                if child.tag.rsplit('}', 1)[-1] in ('assetAdministrationShells', 'conceptDescriptions'):
                                    document.remove(child); removed = True
                            # The original project models predate V3 idShort syntax.
                            # Match prepare_aas.py's known short names, in memory only;
                            # never change global IDs, Property values or semantic keys.
                            renames = {'Rules-SM':'Rules_SM','StateChart-SM':'StateChart_SM','CPS-SM':'CPS_SM','MachineTool-AAS':'MachineTool_AAS','Molder-AAS':'Molder_AAS'}
                            for short in document.iter('{https://admin-shell.io/aas/3/0}idShort'):
                                if short.text in renames:
                                    short.text = renames[short.text]; removed = legacy_names = True
                            if removed: content = ET.tostring(document, encoding='utf-8', xml_declaration=True)
                    elif entry.filename.lower().endswith('.json'):
                        try: document = json.loads(content)
                        except (ValueError, UnicodeDecodeError): document = None
                        if isinstance(document, dict) and 'submodels' in document:
                            content = json.dumps({'submodels':document['submodels']}, allow_nan=False).encode()
                    output.writestr(entry, content)
        objects = model.DictObjectStore()
        files = aasx.DictSupplementaryFileContainer()
        normalized.seek(0)
        with aasx.AASXReader(normalized, failsafe=False) as reader:
            reader.read_into(objects, files)
        environment = json.loads(aas_json.object_store_to_json(objects, allow_nan=False))
        submodels = environment.get('submodels', [])
        if not submodels: raise HTTPException(400, 'No Submodel definitions were found in this AASX package')
        warnings = ['Preview only: select one Submodel. Shells and Concept Descriptions are not imported.']
        if legacy_relationships: warnings.append('Deprecated AASX relationship URLs were normalized in memory; the original file and model IDs are unchanged.')
        if legacy_names: warnings.append('Known legacy project idShorts (e.g. Rules-SM) were normalized to underscores for AAS V3. Original files, global IDs and Property values are unchanged.')
        if len(files): warnings.append('Embedded supplementary files are not uploaded or served; package-local File references will not resolve after import.')
        return {'submodels':submodels, 'warnings':warnings}
    except HTTPException: raise
    except Exception as error:
        raise HTTPException(400, f'AASX could not be read as a supported AAS V3 package: {str(error)[:350]}') from error

def install_template_import(app: Any) -> None:
    @app.post('/api/aas/templates/parse')
    async def preview(request: Request, filename: str) -> dict:
        if not filename.lower().endswith('.aasx'): raise HTTPException(400, 'This parser accepts .aasx templates')
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > MAX_UPLOAD: raise HTTPException(413, 'Template exceeds the 16 MiB upload limit')
        return await run_in_threadpool(parse_aasx, bytes(data))
