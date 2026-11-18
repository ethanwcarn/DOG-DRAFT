"""Pick one photo per breed from the dataset, crop to 4:3, save as JPEG."""
import json, os, sys, glob
from PIL import Image, ImageOps, ImageDraw

DS = sys.argv[1]; OUT = sys.argv[2]; CHOICE = sys.argv[3] if len(sys.argv) > 3 else None
mapping = json.load(open('/tmp/map.json'))
override = json.load(open(CHOICE)) if CHOICE and os.path.exists(CHOICE) else {}
os.makedirs(OUT, exist_ok=True)

def score(path):
    try:
        im = Image.open(path); w, h = im.size
    except Exception:
        return -1
    if min(w, h) < 250: return 0
    ar = w / h
    s = min(w, h)
    if 1.0 <= ar <= 1.8: s *= 2      # landscape-ish fits the 4:3 card best
    if ar < 0.75 or ar > 2.2: s *= 0.3
    return s

picked = {}
for bid, d in sorted(mapping.items()):
    files = sorted(glob.glob(os.path.join(DS, glob.escape(d), 'Image_*')))
    if not files: print('NO FILES', bid); continue
    if bid in override:
        f = os.path.join(DS, d, override[bid])
    else:
        f = max(files, key=score)
    try:
        im = ImageOps.exif_transpose(Image.open(f)).convert('RGB')
    except Exception as e:
        print('BAD', bid, f, e); continue
    im = ImageOps.fit(im, (480, 360), Image.LANCZOS, centering=(0.5, 0.4))
    im.save(os.path.join(OUT, f'{bid}.jpg'), 'JPEG', quality=78, optimize=True, progressive=True)
    picked[bid] = os.path.basename(f)
json.dump(picked, open('/tmp/picked.json', 'w'), indent=1)
print('saved', len(picked))

# Contact sheets for visual review
ids = sorted(picked)
per = 48
for n in range(0, len(ids), per):
    chunk = ids[n:n+per]
    cols = 8; rows = (len(chunk) + cols - 1) // cols
    sheet = Image.new('RGB', (cols*200, rows*175), 'white'); dr = ImageDraw.Draw(sheet)
    for i, bid in enumerate(chunk):
        t = Image.open(os.path.join(OUT, f'{bid}.jpg')).resize((196, 147))
        x, y = (i % cols)*200, (i // cols)*175
        sheet.paste(t, (x+2, y+2)); dr.text((x+4, y+152), bid[:30], fill='black')
    sheet.save(f'/tmp/sheet_{n//per}.jpg', quality=80)
