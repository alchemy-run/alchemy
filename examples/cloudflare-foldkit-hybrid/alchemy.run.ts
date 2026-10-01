import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareFoldkitHybridExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Website.Foldkit("FoldkitHybrid");
    return { url: worker.url };
  }),
);
