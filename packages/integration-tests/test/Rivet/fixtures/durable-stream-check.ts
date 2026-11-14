/**
 * What every pool suite checks through its front's `/durable-stream/<key>`
 * route (see `durable-stream-front.ts`).
 */
import { expect } from "@alchemy.run/test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** The front answered, but not with the stream: its Services pool may still be starting. */
class StreamNotRead extends Data.TaggedError("StreamNotRead")<{
  readonly status: number;
  readonly body: string;
}> {}

const Read = Schema.Struct({ messages: Schema.Array(Schema.Unknown) });
const decodeRead = Schema.decodeUnknownOption(Schema.fromJsonString(Read));

/**
 * Append two messages to a fresh stream through the front and read them
 * back, retrying until the front answers 200 with the stream.
 */
export const expectDurableStream = Effect.fn(function* (baseUrl: string) {
  const client = yield* HttpClient.HttpClient;
  const read = yield* Effect.suspend(() =>
    client.get(`${baseUrl}/durable-stream/${crypto.randomUUID()}`),
  ).pipe(
    Effect.flatMap((res) =>
      Effect.flatMap(res.text, (body) => {
        const decoded = res.status === 200 ? decodeRead(body) : undefined;
        return decoded?._tag === "Some"
          ? Effect.succeed(decoded.value)
          : Effect.fail(new StreamNotRead({ status: res.status, body }));
      }),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );
  expect(read.messages).toEqual([
    { user: "a", text: "one" },
    { user: "b", text: "two" },
  ]);
});
