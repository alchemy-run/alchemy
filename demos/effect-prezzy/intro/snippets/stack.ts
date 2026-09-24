import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./worker.ts";

// #region show
export default Alchemy.Stack(
  "App",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
// #endregion show
