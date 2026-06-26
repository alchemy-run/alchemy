import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import { PutRecords, type PutRecordsRequest } from "./PutRecords.ts";
import type { Stream } from "./Stream.ts";

export const PutRecordsHttp = Layer.effect(
  PutRecords,
  Effect.gen(function* () {
    const putRecords = yield* Kinesis.putRecords;

    return Effect.fn(function* (stream: Stream) {
      const StreamName = yield* stream.streamName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.PutRecords(${stream}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:PutRecords"],
                Resource: [Output.interpolate`${stream.streamArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Kinesis.PutRecords(${stream.LogicalId})`)(
        function* (request: PutRecordsRequest) {
          return yield* putRecords({
            ...request,
            StreamName: yield* StreamName,
          });
        },
      );
    });
  }),
);
