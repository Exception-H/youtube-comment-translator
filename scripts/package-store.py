from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'extension' / 'manifest.json').read_text(encoding='utf-8'))['version']
out = root / 'dist' / f'评论译读-Chrome-v{version}-store.zip'
out.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
    # Chrome Web Store expects manifest.json at the archive root, not nested in a folder.
    for file in sorted((root / 'extension').rglob('*')):
        if file.is_file():
            archive.write(file, file.relative_to(root / 'extension').as_posix())
with zipfile.ZipFile(out) as archive:
    names = archive.namelist()
    assert archive.testzip() is None
    assert 'manifest.json' in names, 'manifest.json must be at archive root'
    assert not any(name.startswith('extension/') for name in names), 'files must not be nested under extension/'
print(out)
print(f'{out.stat().st_size:,} bytes; store layout verified (manifest.json at root)')
