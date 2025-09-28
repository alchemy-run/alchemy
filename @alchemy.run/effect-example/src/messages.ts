import * as Lambda from "@alchemy.run/effect-aws/lambda";
import * as SQS from "@alchemy.run/effect-aws/sqs";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";

// schema
export const Message = S.Struct({
  id: S.Int,
  value: S.String,
});

// resource declaration
export class Messages extends SQS.Queue("messages", {
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
export default consumer.pipe(SQS.clientFromEnv(), Lambda.toHandler);
