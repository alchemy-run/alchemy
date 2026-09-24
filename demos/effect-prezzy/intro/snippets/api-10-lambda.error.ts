import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import { Queues, R2 } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// #region show
const api = Effect.gen(function* () {
  const bucket = yield* R2.Bucket("Uploads");
  const uploads = yield* R2.ReadBucket(bucket);
  const queue = yield* Queues.Queue("Jobs");
  const jobs = yield* Queues.WriteQueue(queue);
  yield* uploads.get("hello.txt")/*hide*/.pipe(Effect.orDie)/*end*/;
  return {
    fetch: Effect.gen(function* () {
      const file = yield* uploads.get("hello.txt");
      yield* jobs.send({ size: file?.size });
      return HttpServerResponse.text("ok");
    })/*hide*/.pipe(Effect.orDie)/*end*/,
  };
}).pipe(
  Effect.provide([R2.ReadBucketBinding, Queues.WriteQueueBinding]),
  Effect.provide(Alchemy.RuntimeContext.phantom),
);

export default class Api extends AWS.Lambda.Function<Api>()(
  "Api", { main: import.meta.url }, api,
) {}
// #endregion show
