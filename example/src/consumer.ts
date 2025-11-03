import { $ } from "alchemy-effect";
import * as Lambda from "alchemy-effect/aws/lambda";
import * as SQS from "alchemy-effect/aws/sqs";
import * as Effect from "effect/Effect";
import { Messages } from "./messages.ts";

// business logic
export class Consumer extends Lambda.consume("Consumer", {
  queue: Messages,
  handle: Effect.fn(function* (batch) {
    for (const record of batch.Records) {
      console.log(record);

      yield* SQS.sendMessage(Messages, {
        id: 1,
        value: "1",
      }).pipe(Effect.catchAll(() => Effect.void));
    }
  }),
})({
  main: import.meta.filename,
  bindings: $(SQS.SendMessage(Messages)),
  memory: 128,
}) {}

// runtime handler
// export default Consumer.pipe(
//   Effect.provide(SQS.clientFromEnv()),
//   Lambda.toHandler,
// );
