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
    const worker = yield* Cloudflare.Website.Vite("Foldkit", {
      compatibility: {
        flags: ["nodejs_compat"],
      },
      assets: {
        notFoundHandling: "single-page-application",
      },
    });

    return {
      url: worker.url,
    };
  }),
);
