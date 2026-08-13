import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Site from "./src/site.ts";

export default Alchemy.Stack(
  "CloudflareTanstackExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // The Website class (and its Effect API + R2 binding) is defined in
    // ./src/site.ts — yielding it deploys the whole thing: one Worker
    // serving the TanStack Start frontend and the Effect-native /api/*.
    const website = yield* Site;

    return {
      url: website.url.as<string>(),
    };
  }),
);
