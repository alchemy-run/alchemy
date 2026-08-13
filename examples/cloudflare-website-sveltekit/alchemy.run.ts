import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Site from "./src/site.ts";

export default Alchemy.Stack(
  "CloudflareWebsiteSvelteKitExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // The Website class (and its Effect API + KV binding) is defined in
    // ./src/site.ts — yielding it deploys the whole thing.
    const site = yield* Site;

    return {
      url: site.url,
    };
  }),
);
