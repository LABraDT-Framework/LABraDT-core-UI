"""Prepare standards-compliant copies; never overwrite original AASX packages or IDs."""
from pathlib import Path
import re
import zipfile

from backend.settings import VERSION_DIR as ROOT, FRAMEWORK_DIR
RESOURCES = FRAMEWORK_DIR / 'engine/src/main/resources'
RENAMES = {'Rules-SM': 'Rules_SM', 'StateChart-SM': 'StateChart_SM', 'CPS-SM': 'CPS_SM', 'MachineTool-AAS': 'MachineTool_AAS', 'Molder-AAS': 'Molder_AAS'}

def prepare(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(target, 'w') as output:
        for entry in original.infolist():
            data = original.read(entry.filename)
            if entry.filename.endswith('.xml'):
                xml = data.decode('utf-8-sig')
                # Only short names and textual submodel role references change.
                # <id>, Reference/Key values and package paths remain untouched.
                for old, new in RENAMES.items():
                    xml = re.sub(r'(<(?:\w+:)?(?:idShort|value)>\s*)' + re.escape(old) + r'(\s*</(?:\w+:)?(?:idShort|value)>)', lambda m: m[1] + new + m[2], xml)
                data = xml.encode('utf-8')
            output.writestr(entry, data)

if __name__ == '__main__':
    for name in ('MachineTool.aasx', 'Molder.aasx'):
        if (RESOURCES / name).exists():
            prepare(RESOURCES / name, ROOT / 'data/repository' / name)
            print(f'Prepared data/repository/{name} (global identifiers preserved)')
