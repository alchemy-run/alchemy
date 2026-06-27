import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { GetRecords, type GetRecordsRequest } from "./GetRecords.ts";
import type { Stream } from "./Stream.ts";

export const GetRecordsHttp = Layer.effect(
  GetRecords,
  Effect.gen(function* () {
    const getRecords = yield* Kinesis.getRecords;

    return Effect.fn(function* (stream: Stream) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.GetRecords(${stream}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:GetRecords"],
                Resource: [stream.streamArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Kinesis.GetRecords(${stream.LogicalId})`)(
        function* (request: GetRecordsRequest) {
          return yield* getRecords(request);
        },
      );
    });
  }),
);
