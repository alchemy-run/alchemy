import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareWebsiteWakuExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.Waku("WakuSite", {
      // Waku's server runtime needs AsyncLocalStorage.
      compatibility: {
        flags: ["nodejs_als"],
      },
      env: {
        GREETING: "Hello from alchemy",
      },
    });

    return {
      url: site.url,
    };
  }),
);
