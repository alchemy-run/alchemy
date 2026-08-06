import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareFoldkitExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // `Website.Foldkit` applies the SPA fallback itself, so deep links
    // reach the Foldkit router without an `assets` config here.
    const worker = yield* Cloudflare.Website.Foldkit("Foldkit", {
      compatibility: {
        flags: ["nodejs_compat"],
      },
      memo: {},
    });

    return {
      url: worker.url,
    };
  }),
);
