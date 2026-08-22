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
    // This example is a client-only Foldkit app: no route has a file of its
    // own, so a deep link has to be answered with the template for the app's
    // router to resolve it. Asset routing carries no default, because a
    // server-rendered Foldkit app wants the opposite — see the `assets` docs
    // on `Cloudflare.Website.Foldkit`.
    const worker = yield* Cloudflare.Website.Foldkit("Foldkit", {
      assets: {
        notFoundHandling: "single-page-application",
      },
    });

    return {
      url: worker.url,
    };
  }),
);
