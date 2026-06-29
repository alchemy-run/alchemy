import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";
import {
  SubscribeToShard,
  type SubscribeToShardRequest,
} from "./SubscribeToShard.ts";

export const SubscribeToShardHttp = Layer.effect(
  SubscribeToShard,
  Effect.gen(function* () {
    const subscribeToShard = yield* Kinesis.subscribeToShard;

    return Effect.fn(function* (consumer: StreamConsumer) {
      const ConsumerARN = yield* consumer.consumerArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.SubscribeToShard(${consumer}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["kinesis:SubscribeToShard"],
                  Resource: [consumer.consumerArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Kinesis.SubscribeToShard(${consumer.LogicalId})`)(
        function* (request: SubscribeToShardRequest) {
          return yield* subscribeToShard({
            ...request,
            ConsumerARN: yield* ConsumerARN,
          });
        },
      );
    });
  }),
);
