"""Build Chrome Web Store image assets from existing screenshots.

Outputs (design/store/):
  screenshot-1-dual-search.png   1280x800
  screenshot-2-settings.png      1280x800
  promo-440x280.png              440x280
  icon-128.png                   128x128
"""
from pathlib import Path
from PIL import Image, ImageOps

root = Path(__file__).resolve().parents[1]
out = root / 'design' / 'store'
out.mkdir(parents=True, exist_ok=True)


def save(image, size, path):
    fitted = ImageOps.fit(image.convert('RGB'), size, method=Image.LANCZOS, centering=(0.5, 0.5))
    fitted.save(path, 'PNG', optimize=True)
    print(f'{path.name}: {fitted.width}x{fitted.height}')


dual = Image.open(root / 'tests' / 'dual-search-live-desktop.png')
save(dual, (1280, 800), out / 'screenshot-1-dual-search.png')
save(dual, (440, 280), out / 'promo-440x280.png')

options = Image.open(root / 'tests' / 'store-options.png')
# Keep the top of the settings page (preset, keyless panel, save button).
top = options.crop((0, 0, options.width, min(options.height, 800)))
save(top, (1280, 800), out / 'screenshot-2-settings.png')

icon = Image.open(root / 'extension' / 'icons' / 'icon128.png')
icon.convert('RGBA').save(out / 'icon-128.png', 'PNG', optimize=True)
print('icon-128.png:', icon.width, 'x', icon.height)
