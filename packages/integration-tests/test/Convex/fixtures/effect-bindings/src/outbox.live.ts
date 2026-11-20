import * as AWS from "@alchemy.run/aws";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Outbox, Publish } from "./outbox.ts";

// The constructor binds the queue: at deploy that creates an IAM user and
// role allowed to send to it, and sets their key on the deployment. The
// `Config` it reads at deploy is set on the deployment too.
export const OutboxLive = Layer.effect(
  Publish,
  Effect.gen(function* () {
    const send = yield* AWS.SQS.SendMessage(Outbox);
    const tag = yield* Config.String("OUTBOX_TAG");
    return Effect.fn(function* ({ body }) {
      const sent = yield* send({ MessageBody: `${tag}: ${body}` }).pipe(Effect.orDie);
      return sent.MessageId ?? "";
    });
  }),
).pipe(Layer.provide(AWS.SQS.SendMessageHttp));
