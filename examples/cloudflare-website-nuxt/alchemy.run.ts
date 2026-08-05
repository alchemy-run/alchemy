import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareWebsiteNuxtExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.Nuxt("NuxtSite", {
      env: {
        GREETING: "Hello from alchemy",
      },
    });

    return {
      url: site.url,
    };
  }),
);
