import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Queue } from "../cloudflare/queue.ts";

export class Messages extends Queue.Resource("messages")<{
  key: string;
  value: string;
}>() {}

// alternative way to declare a queue with a schema
export class Messages2 extends Queue.Resource("messages2", {
  schema: Schema.Struct({
    key: Schema.String,
    value: Schema.String,
  }),
}) {}

export const consumer = Messages.consume(
  Effect.fn(function* (batch) {
    for (const message of batch.messages) {
      yield* Messages2.send(message.body);
      yield* Messages.send(message.body);
      yield* Console.log(message.body);
    }
  }),
);
