import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Broadcast } from "./src/Broadcast.ts";

export default Alchemy.Stack(
  "CloudflareStreamWebRTCExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const broadcast = yield* Broadcast;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      liveInputId: broadcast.liveInputId,
      // The WHEP URL is safe to publish as a stack output. `webRTCUrl` is
      // deliberately not returned here — it is a `Redacted` publish secret
      // and only the Worker needs it.
      webRTCPlaybackUrl: broadcast.webRTCPlaybackUrl,
    };
  }),
);
