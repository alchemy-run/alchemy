import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Queues, R2 } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// #region show
const api = Effect.gen(function* () {
  return {
    fetch: Effect.gen(function* () {
      return HttpServerResponse.text("ok");
    }),
  };
});

export default class Api extends Cloudflare.Worker<Api>()(
  "Api", { main: import.meta.url }, api,
) {}
// #endregion show
