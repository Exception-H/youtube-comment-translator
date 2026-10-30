from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
folder = root / 'extension' / 'icons'
folder.mkdir(parents=True, exist_ok=True)
image = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((12, 12, 500, 500), radius=116, fill='#162741')
draw.rounded_rectangle((68, 84, 343, 277), radius=48, fill='#F23545')
draw.polygon(((177, 127), (177, 230), (265, 178)), fill='white')
draw.rounded_rectangle((223, 238, 452, 449), radius=51, fill='#3D7CD5')
draw.polygon(((265, 423), (255, 471), (321, 433)), fill='#3D7CD5')
font = ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc', 154)
draw.text((261, 248), '文', font=font, fill='white', stroke_width=0)
for size in (16, 32, 48, 128):
    image.resize((size, size), Image.Resampling.LANCZOS).save(folder / f'icon{size}.png')
print('Generated extension icons: 16, 32, 48, 128')
