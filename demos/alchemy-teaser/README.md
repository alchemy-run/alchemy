# Alchemy

A 1920x1080 @ 30 fps video made with [fframes](https://github.com/dmtrKovalenko/fframes),
rendered with the Skia (Metal) backend.

| file | what |
| --- | --- |
| `src/lib.rs` | the video: scenes, animation, audio map |
| `src/main.rs` | the command line (`fframes::cli`) |
| `media/` | fonts, images and audio embedded into the binary |
| `tests/frames.rs` | frame snapshots and a check of every frame for problems |

## Work on it

```sh
cargo run --release -- timeline                      # scenes, duration, audio tracks
cargo run --release -- frame 1s,50%,end              # PNGs into frames/ and the problems found in them
cargo run --release -- strip DataScene -n 8        # contact sheet, writes strip.png
cargo run --release -- onion "ProductScene@0..ProductScene@1.5s"  # motion trail of an entrance, writes onion.png
cargo run --release -- inspect                       # missing media/fonts, clipped text, panics in any frame
cargo run --release -- render DataScene --draft    # a part of the video, half resolution, fast preset
cargo run --release -- audio analyze --waveform w.png  # loudness (LUFS), peaks, silence per scene
cargo run --release -- render                        # the final video, writes out.mp4
cargo run --release -- preview                       # real-time GPU window with sound (space, h/l, j/k, q)
cargo test                            # frame snapshots (FFRAMES_UPDATE_SNAPSHOTS=1 to accept)
```

Times accept frames (`120`), seconds (`3.2s`), `m:ss`, percentages (`50%`), scenes (`DataScene`,
`#1`) and offsets inside scenes (`DataScene@1.5s`, `@50%`, `@end`). Add `--json` to any
command for machine-readable output.
