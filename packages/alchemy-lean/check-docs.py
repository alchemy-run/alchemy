#!/usr/bin/env python3
"""Checks that every line of Lean shown in the README and the guide is a line of
the library or an example, so the documents cannot drift from code that compiles.
A line holding `…` marks a cut and is skipped, and a line may stop short of
the one in the code, as a statement shown without its proof does. Run from this directory."""
import pathlib, re, sys

root = pathlib.Path(__file__).parent
source = set()
for path in list(root.glob("examples/**/*.lean")) + list(root.glob("Alchemy/**/*.lean")):
    for line in path.read_text().splitlines():
        source.add(" ".join(line.split()))

missing = []
for doc in sys.argv[1:] or ["README.md", "GUIDE.md"]:
    text = (root / doc).read_text() if not doc.startswith("/") else pathlib.Path(doc).read_text()
    for block in re.findall(r"```lean\n(.*?)```", text, flags=re.S):
        for line in block.splitlines():
            shown = " ".join(line.split())
            if not shown or "…" in shown or shown.startswith("--") or shown.startswith("#check"):
                continue
            if shown in source:
                continue
            # A statement shown without its proof: `theorem … :=` cut before `by`.
            if any(have.startswith(shown) for have in source):
                continue
            missing.append((doc, line))

for doc, line in missing:
    print(f"{doc}: not in the code: {line}")
sys.exit(1 if missing else 0)
