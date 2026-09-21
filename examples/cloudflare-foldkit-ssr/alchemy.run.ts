import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareFoldkitSsrExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // One declaration. The app's own `vite.config.ts` (`ssr.build`) makes
    // the build emit a fetch handler alongside the browser bundle, and that
    // handler is the Worker. Asset routing follows from what the build
    // wrote down: nothing is prerendered here, so the bare template stays
    // out of the upload and every page request reaches the handler.
    const worker = yield* Cloudflare.Website.Foldkit("FoldkitSsr");

    return {
      url: worker.url,
    };
  }),
);
