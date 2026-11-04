#!/usr/bin/env python3
"""Screenshot docs pages from the dev server and put every diagram on one sheet.

Usage: diagram-sheet.py <out.png> <path>...   e.g. diagram-sheet.py /tmp/sheet.png aws/iam cloudflare/data/kv
       diagram-sheet.py --split <dir> <path>...  one PNG per diagram, at page size

--split writes <dir>/<page>-<n>.png, one file per diagram in page order and
at the size a reader sees it (the sheet shrinks everything to one width). Use
it to show diagrams one by one in a review, or to check text is readable.

Each page is shot at 2x in dark mode, every DAG figure is cropped out by its
panel colour, and the crops are laid out two per row in <out.png>. Read the
sheet: overflowing labels, labels on borders and missing edges show up there.
Needs the dev server (pnpm exec astro dev in website/) and Pillow.
"""
import os
import subprocess
import sys
import tempfile
import time

from PIL import Image

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FIGURE = (34, 30, 24)  # .alc-dag panel background in the dark theme
# SHEET_SCALE=1 captures 15000 CSS px instead of 4000, for long pages whose
# last diagrams fall off the 2x capture.
SCALE = int(os.environ.get("SHEET_SCALE", "2"))
SCAN_X = 350 * SCALE  # a column inside the content area, left of any node


def shoot(paths, tmp):
    procs, files = [], []
    for p in paths:
        out = os.path.join(tmp, p.strip("/").replace("/", "_") + ".png")
        files.append(out)
        procs.append(
            subprocess.Popen(
                [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                 "--virtual-time-budget=6000", f"--force-device-scale-factor={SCALE}",
                 f"--window-size=1300,{8000 if SCALE == 2 else 15000}", f"--screenshot={out}",
                 f"http://localhost:4321/{p.strip('/')}/"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        )
    # Headless Chrome never exits against the dev server (the HMR socket stays open).
    time.sleep(30)
    for proc in procs:
        proc.kill()
    return files


def figures(path):
    im = Image.open(path).convert("RGB")
    _, height = im.size
    runs, y = [], 0
    while y < height:
        if im.getpixel((SCAN_X, y)) == FIGURE:
            start = y
            while y < height and im.getpixel((SCAN_X, y)) == FIGURE:
                y += SCALE
            if runs and start - runs[-1][1] < 40 * SCALE:
                runs[-1][1] = y
            else:
                runs.append([start, y])
        y += SCALE
    return [im.crop((330 * SCALE, s - 5 * SCALE, 970 * SCALE, e + 5 * SCALE)) for s, e in runs if e - s >= 100 * SCALE]


def split(out_dir, paths):
    os.makedirs(out_dir, exist_ok=True)
    count = 0
    with tempfile.TemporaryDirectory() as tmp:
        for page, f in zip(paths, shoot(paths, tmp)):
            for n, crop in enumerate(figures(f)):
                name = os.path.join(out_dir, f"{page.strip('/').replace('/', '_')}-{n}.png")
                # Back to CSS pixels, so the file is the size the page shows.
                crop.resize((crop.size[0] // SCALE, crop.size[1] // SCALE)).save(name)
                print(name)
                count += 1
    print(f"{count} diagrams -> {out_dir}")


def main():
    if sys.argv[1] == "--split":
        return split(sys.argv[2], sys.argv[3:])
    out, paths = sys.argv[1], sys.argv[2:]
    with tempfile.TemporaryDirectory() as tmp:
        crops = [c.resize((620, int(c.size[1] * 620 / c.size[0])))
                 for f in shoot(paths, tmp) for c in figures(f)]
    rows = [crops[i:i + 2] for i in range(0, len(crops), 2)]
    sheet = Image.new("RGB", (1250, sum(max(c.size[1] for c in r) for r in rows) or 1))
    y = 0
    for row in rows:
        for i, crop in enumerate(row):
            sheet.paste(crop, (i * 630, y))
        y += max(c.size[1] for c in row)
    sheet.save(out)
    print(f"{len(crops)} diagrams -> {out}")


main()
