import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { ListShards, type ListShardsRequest } from "./ListShards.ts";
import type { Stream } from "./Stream.ts";

export const ListShardsHttp = Layer.effect(
  ListShards,
  Effect.gen(function* () {
    const listShards = yield* Kinesis.listShards;

    return Effect.fn(function* (stream: Stream) {
      const StreamARN = yield* stream.streamArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.ListShards(${stream}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:ListShards"],
                Resource: [stream.streamArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Kinesis.ListShards(${stream.LogicalId})`)(
        function* (request?: ListShardsRequest) {
          return yield* listShards({
            ...request,
            StreamARN: yield* StreamARN,
          });
        },
      );
    });
  }),
);
