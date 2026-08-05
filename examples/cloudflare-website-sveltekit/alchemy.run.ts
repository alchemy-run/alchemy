import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareWebsiteSvelteKitExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.SvelteKit("SvelteKitSite", {
      env: {
        GREETING: "Hello from alchemy",
      },
    });

    return {
      url: site.url,
    };
  }),
);
