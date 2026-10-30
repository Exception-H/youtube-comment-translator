from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'extension' / 'manifest.json').read_text(encoding='utf-8'))['version']
out = root / 'dist' / f'评论译读-Chrome-v{version}.zip'
out.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted((root / 'extension').rglob('*')):
        if file.is_file():
            archive.write(file, file.relative_to(root).as_posix())
    for name in ('README.md', 'PRIVACY.md', 'LICENSE', 'VALIDATION.md'):
        archive.write(root / name, name)
with zipfile.ZipFile(out) as archive:
    assert archive.testzip() is None
    assert 'extension/manifest.json' in archive.namelist()
print(out)
print(f'{out.stat().st_size:,} bytes; archive integrity verified')
