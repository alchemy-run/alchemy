import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Queues, R2 } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// #region show
const api = Effect.gen(function* () {
  const bucket = yield* R2.Bucket("Uploads");
  const uploads = yield* R2.ReadBucket(bucket);
  return {
    fetch: Effect.gen(function* () {
      const file = yield* uploads.get("hello.txt");
      return HttpServerResponse.text("ok");
    }).pipe(Effect.orDie),
  };
});

export default class Api extends Cloudflare.Worker<Api>()(
  "Api", { main: import.meta.url }, api,
) {}
// #endregion show
