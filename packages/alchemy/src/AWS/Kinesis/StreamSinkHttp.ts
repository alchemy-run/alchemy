import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import { isFunction } from "../Lambda/Function.ts";
import { PutRecords } from "./PutRecords.ts";
import { StreamSink, type StreamSinkRecord } from "./StreamSink.ts";
import type { Stream } from "./Stream.ts";

export const StreamSinkHttp = Layer.effect(
  StreamSink,
  Effect.gen(function* () {
    const putRecords = yield* PutRecords;

    return Effect.fn(function* (stream: Stream) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.StreamSink(${stream}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:PutRecords"],
                Resource: [stream.streamArn],
              },
            ],
          });
        }
      }
      const publish = yield* putRecords(stream);
      return Sink.forEachArray((records: readonly StreamSinkRecord[]) =>
        publish({
          Records: [...records],
        }).pipe(Effect.orDie, Effect.asVoid),
      );
    });
  }),
);
