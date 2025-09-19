import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import * as Lambda from "../aws/function.ts";
import * as Queue from "../aws/queue.ts";
import * as Policy from "../policy.ts";

// schema
export const Message = S.Struct({
  id: S.Int,
  value: S.String,
});

// resource declaration
export class Messages extends Queue.Tag("messages", {
  fifo: true,
  message: Message,
}) {}

// business logic
export const consumer = Messages.consume(
  Effect.fn(function* (batch) {
    for (const record of batch.Records) {
      console.log(record);
    }
  }),
);

// runtime handler
export default consumer.pipe(
  Effect.provide(Queue.clientFromEnv),
  Lambda.toHandler,
);

// infrastructure
export class Consumer extends Lambda.make(consumer, {
  main: import.meta.file,
  policy: Policy.of(Queue.Consume(Messages)),
}) {}
