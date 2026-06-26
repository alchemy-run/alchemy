import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  GetShardIterator,
  type GetShardIteratorRequest,
} from "./GetShardIterator.ts";
import type { Stream } from "./Stream.ts";

export const GetShardIteratorHttp = Layer.effect(
  GetShardIterator,
  Effect.gen(function* () {
    const getShardIterator = yield* Kinesis.getShardIterator;

    return Effect.fn(function* (stream: Stream) {
      const StreamARN = yield* stream.streamArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.GetShardIterator(${stream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["kinesis:GetShardIterator"],
                  Resource: [stream.streamArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Kinesis.GetShardIterator(${stream.LogicalId})`)(
        function* (request: GetShardIteratorRequest) {
          return yield* getShardIterator({
            ...request,
            StreamARN: yield* StreamARN,
          });
        },
      );
    });
  }),
);
