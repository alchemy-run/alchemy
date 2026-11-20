import * as SQS from "@alchemy.run/aws/SQS";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * A Cloudflare Worker run locally by `alchemy dev`, bound to an SQS queue in
 * the real cloud: a call no dev bridge carries yet.
 */
export default class RemoteQueueWorker extends Cloudflare.Worker<RemoteQueueWorker>()(
  "RemoteQueueWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("CloudflareHostQueue").pipe(Alchemy.remote());
    const sendMessage = yield* SQS.SendMessage(queue);
    return {
      fetch: sendMessage({ MessageBody: "from-a-worker" }).pipe(
        Effect.as(HttpServerResponse.text("ok")),
        Effect.catch(() => Effect.succeed(HttpServerResponse.text("failed", { status: 500 }))),
      ),
    };
  }).pipe(Effect.provide(SQS.SendMessageHttp)),
) {}
