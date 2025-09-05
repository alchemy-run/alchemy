import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Queue } from "../queue.ts";

export class Messages extends Queue("Messages")<{
  key: string;
  value: string;
}>() {}

// alternative way to declare a queue with a schema
export class Messages2 extends Queue("Messages2", {
  schema: Schema.Struct({
    key: Schema.String,
    value: Schema.String,
  }),
}) {}

export const consumer = Messages.consume(
  Effect.fn(function* (batch) {
    for (const message of batch.messages) {
      yield* Messages2.send(message);
      yield* Messages.send(message);
      yield* Console.log(message);
    }
  }),
);
