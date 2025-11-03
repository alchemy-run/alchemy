import { $ } from "alchemy-effect";
import * as Lambda from "alchemy-effect/aws/lambda";
import * as SQS from "alchemy-effect/aws/sqs";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { Message, Messages } from "./messages.ts";

export class Api extends Lambda.serve("Api", {
  fetch: Effect.fn(function* (event) {
    const msg = yield* S.validate(Message)(event.body).pipe(
      Effect.catchAll(Effect.die),
    );
    yield* SQS.sendMessage(Messages, msg).pipe(
      Effect.catchAll(() => Effect.void),
    );
    return {
      body: JSON.stringify(null),
    };
  }),
})({
  main: import.meta.filename,
  bindings: $(SQS.SendMessage(Messages)),
}) {}

export default Api.handler.pipe(
  Effect.provide(SQS.clientFromEnv()),
  Lambda.toHandler,
);
