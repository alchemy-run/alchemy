# What is Alchemy? (talk)

The "What is Alchemy?" docs page and the compare page as an animated talk
you step through and record over. Built with [Remotion](https://remotion.dev): one composition,
one step per key press.

```sh
pnpm dev       # the presenter at http://localhost:5299
pnpm studio    # Remotion Studio, frame by frame
pnpm typecheck # the talk, and every snippet against the real packages
```

In the presenter, → plays the next step and stops at its end, ← goes back,
R replays, N toggles the notes (what to say) and F goes fullscreen for
recording.

| Path | What it is |
| --- | --- |
| `src/steps.ts` | The talk, in order: each step's caption, notes and scene |
| `src/scenes/` | One file per scene: versus, one line, permissions, phases, layers, engine, deploy, dev, loop, at a glance |
| `src/ui.tsx` | The code window, heading and pill every scene shares |
| `snippets/` | The code on screen, type-checked; the slide shows `// #region show` |
| `src/present.tsx` | The presenter |
