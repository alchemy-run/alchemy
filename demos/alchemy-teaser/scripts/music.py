#!/usr/bin/env python3
"""Synthesizes media/music.mp3: a 128 BPM track, 54 bars (101.25 s), laid out to match
the scenes in src/lib.rs (each scene is a whole number of bars).

  bars  0-3   intro: pad + hats          bar  16     riser (no kick)
  bars  4-15  kick + hats                bars 17-48  drop: kick, clap, hats, sidechained bass, arp
  bars 12-15  + pad                      bars 49-53  impact + pad tail

Needs numpy and ffmpeg.
"""
import os
import subprocess

import numpy as np

SR = 44100
BEAT = 60 / 128
BAR = BEAT * 4
LENGTH = 54 * BAR
t = np.arange(int(LENGTH * SR)) / SR
bar = t / BAR
rng = np.random.default_rng(7)
noise = rng.uniform(-1, 1, t.size)

# Chord roots per bar: A, F, C, G (in Hz, bass octave).
roots = np.array([55.0, 43.65, 65.41, 49.0])[(np.floor(bar) % 4).astype(int)]


def between(lo, hi):
    return ((bar >= lo) & (bar < hi)).astype(float)


kick_on = between(4, 16) + between(17, 49)
drop = between(17, 49)

# Kick: a pitch-swept sine on every beat.
kb = np.mod(t, BEAT)
kick = np.sin(2 * np.pi * (48 * kb + 7 * (1 - np.exp(-35 * kb)))) * np.exp(-6 * kb)

# Sidechain: everything else ducks on the kick.
duck = 1 - 0.75 * kick_on * np.exp(-9 * kb)

# Hats on the off-beats, a clap on beats 2 and 4 in the drop.
hb = np.mod(t + BEAT / 2, BEAT)
hats = noise * np.exp(-60 * hb)
cb = np.mod(t - BEAT, 2 * BEAT)
clap = noise * np.exp(-18 * cb) * drop

# Bass: saw-ish, following the roots.
phase = np.cumsum(roots) / SR
bass = (np.sin(2 * np.pi * phase) + 0.5 * np.sin(4 * np.pi * phase) + 0.25 * np.sin(6 * np.pi * phase)) * drop

# Pad: a soft chord.
pad = (
    np.sin(2 * np.pi * 2 * phase) + np.sin(2 * np.pi * 3 * phase) + np.sin(2 * np.pi * 2.52 * phase)
) * (between(0, 4) + between(12, 17) + between(49, 54))

# Arp: 16th notes over the chord in the drop.
sixteenth = np.floor(t / (BEAT / 4)).astype(int)
arp_mult = np.array([4, 6, 5, 8])[sixteenth % 4]
sb = np.mod(t, BEAT / 4)
arp = np.sin(2 * np.pi * np.cumsum(roots * arp_mult) / SR) * np.exp(-14 * sb) * between(25, 49)

# Riser in bar 16: noise swelling plus a rising sweep.
r = np.clip((t - 16 * BAR) / BAR, 0, 1) * between(16, 17)
riser = r**2 * (0.6 * noise + 0.4 * np.sin(2 * np.pi * np.cumsum(200 + 900 * r) / SR))

# Impact at bar 49: a deep boom and a noise burst.
it = np.clip(t - 49 * BAR, 0, None) * between(49, 54)
impact = (np.sin(2 * np.pi * (34 * it + 9 * (1 - np.exp(-20 * it)))) * np.exp(-1.8 * it) + 0.5 * noise * np.exp(-5 * it)) * (it > 0)

mix = (
    0.95 * kick * kick_on
    + 0.10 * hats * (kick_on + between(0, 4))
    + 0.22 * clap
    + 0.30 * bass * duck
    + 0.07 * pad * duck
    + 0.10 * arp * duck
    + 0.55 * riser
    + 0.9 * impact
)

# Gentle fade at the very end, then normalise to -1 dBFS peak.
mix *= np.clip((LENGTH - t) / 1.5, 0, 1)
mix = mix / np.max(np.abs(mix)) * 10 ** (-1 / 20)

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "..", "media", "music.mp3")
subprocess.run(
    # A little gain into a limiter brings it near -14 LUFS without flattening the dynamics.
    ["ffmpeg", "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
     "-af", "volume=2.2,alimiter=limit=0.89:attack=2:release=60:level=false", "-b:a", "192k", out],
    input=mix.astype(np.float32).tobytes(),
    check=True,
)
print("wrote media/music.mp3")
