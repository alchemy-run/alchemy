import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";

export default Stack.make(
  "CloudflareTanstackExample",
  Cloudflare.providers(),
)(
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Vite("TanStackStart", {
      compatibility: {
        flags: ["nodejs_compat"],
      },
    });
    return {
      url: worker.url,
    };
  }),
);
