import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Queues, R2 } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// #region show
export default class Api extends Cloudflare.Worker<Api>()(
  "Api", { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* R2.Bucket("Uploads");
    const uploads = yield* R2.ReadBucket(bucket);
    const queue = yield* Queues.Queue("Jobs");
    const jobs = yield* Queues.WriteQueue(queue);
    yield* uploads.get("hello.txt").pipe(Effect.orDie);
    return {
      fetch: Effect.gen(function* () {
        const file = yield* uploads.get("hello.txt");
        yield* jobs.send({ size: file?.size });
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide([R2.ReadBucketHttp, Queues.WriteQueueBinding]),
  ),
) {}
// #endregion show
