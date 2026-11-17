# Verifying a Domain model, in under a minute

A Remotion video that shows how a `@alchemy.run/domain` model is written and how its rules are proved: the aggregate and its rule, the one test, the proof, a bug the proof finds, a decision across instances, and the search over the whole model.

```sh
pnpm studio   # edit with live preview
pnpm render   # out/domain-verify.mp4
```

The rendered video is checked in at [`out/domain-verify.mp4`](./out/domain-verify.mp4).

The bottom right corner of every scene is left empty for a camera picture laid over the video. The `DomainVerifyGuide` composition outlines it (`FACE` in `src/theme.ts` sets its size).

Each scene is one file in `src/scenes`, and `src/Video.tsx` puts them in order with their lengths.
