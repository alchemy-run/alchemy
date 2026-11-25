# @alchemy.run/mux

[Mux](https://www.mux.com) for [Alchemy](https://alchemy.run). Declare video assets, live streams, captions, webhooks and signing keys next to the code that serves them.

```sh
npm install alchemy @alchemy.run/mux effect
```

A video with AI captions, a low-latency live stream, and a webhook:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Mux from "@alchemy.run/mux";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Video",
  {
    providers: Mux.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const intro = yield* Mux.Video.Asset("Intro", {
      inputs: [
        {
          url: "https://muxed.s3.amazonaws.com/leds.mp4",
          generated_subtitles: [{ language_code: "en", name: "English (generated)" }],
        },
      ],
      playback_policies: ["public"],
      meta: { title: "Intro" },
    });

    const stream = yield* Mux.Video.LiveStream("MainStage", {
      playback_policies: ["public"],
      latency_mode: "low",
    });

    const hook = yield* Mux.System.Webhook("Events", {
      address: "https://api.example.com/mux/events",
    });

    return {
      introPlaybackId: intro.public_playback_id,
      streamPlaybackId: stream.public_playback_id,
      streamKey: stream.stream_key,
      webhookSecret: hook.signing_secret,
    };
  }),
);
```

Updates compare your props with what Mux reports, so a failed deploy is finished or undone by the next one, and `alchemy deploy --detect-drift` puts back changes made in the Mux dashboard.

## Learn more

- [Mux on alchemy.run](https://alchemy.run/mux)
- [Setup](https://alchemy.run/mux/setup)
