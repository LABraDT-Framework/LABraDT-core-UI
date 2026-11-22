"""Run structural checks and existing unit regressions from any working directory."""
import ast
from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / 'frontend'


class AssetReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in {'src', 'href'} and value:
                parsed = urlsplit(value)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                path = unquote(parsed.path).removeprefix('/static/').lstrip('/')
                self.paths.append(FRONTEND / path)


def main():
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js 22+ is required for JavaScript validation.')
    html = (FRONTEND / 'index.html').read_text(encoding='utf-8')
    parser = AssetReferences()
    parser.feed(html)
    for asset in parser.paths:
        if not asset.is_file() or not asset.resolve().is_relative_to(FRONTEND.resolve()):
            raise SystemExit(f'Missing or invalid frontend resource: {asset}')
    for folder in ('backend', 'scripts', 'mock', 'tests/python', 'tools'):
        for source in (ROOT / folder).rglob('*.py'):
            ast.parse(source.read_text(encoding='utf-8'), filename=str(source))
    for script in sorted((FRONTEND / 'assets/js').rglob('*.js')):
        subprocess.run([node, '--check', str(script)], check=True, cwd=ROOT)
    print(f'PASS: Python/JavaScript syntax and {len(parser.paths)} frontend resource references', flush=True)
    subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/python', '-v'], check=True, cwd=ROOT)
    # Expand explicitly so this also works on Windows shells and older Node runners.
    tests = sorted(str(p) for p in (ROOT / 'tests/js').glob('*.test.cjs'))
    subprocess.run([node, '--test', *tests], check=True, cwd=ROOT)
    print('PASS: all structural and unit checks', flush=True)


if __name__ == '__main__':
    main()
