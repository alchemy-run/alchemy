import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Site from "./server/backend.ts";

export default Alchemy.Stack(
  "CloudflareWebsiteNuxtExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // The Website class (and its Effect API + KV binding) is defined in
    // ./server/backend.ts — yielding it deploys the whole thing.
    const site = yield* Site;

    return {
      url: site.url,
    };
  }),
);
