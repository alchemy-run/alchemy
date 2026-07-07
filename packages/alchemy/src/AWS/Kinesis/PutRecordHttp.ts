import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import { PutRecord, type PutRecordRequest } from "./PutRecord.ts";
import type { Stream } from "./Stream.ts";

export const PutRecordHttp = Layer.effect(
  PutRecord,
  Effect.gen(function* () {
    const putRecord = yield* Kinesis.putRecord;

    return Effect.fn(function* (stream: Stream) {
      const StreamName = yield* stream.streamName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.PutRecord(${stream}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:PutRecord"],
                Resource: [Output.interpolate`${stream.streamArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Kinesis.PutRecord(${stream.LogicalId})`)(function* (
        request: PutRecordRequest,
      ) {
        return yield* putRecord({
          ...request,
          StreamName: yield* StreamName,
        });
      });
    });
  }),
);
