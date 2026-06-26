import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeStreamConsumer,
  type DescribeStreamConsumerRequest,
} from "./DescribeStreamConsumer.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

export const DescribeStreamConsumerHttp = Layer.effect(
  DescribeStreamConsumer,
  Effect.gen(function* () {
    const describeStreamConsumer = yield* Kinesis.describeStreamConsumer;

    return Effect.fn(function* (consumer: StreamConsumer) {
      const ConsumerARN = yield* consumer.consumerArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.DescribeStreamConsumer(${consumer}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["kinesis:DescribeStreamConsumer"],
                  Resource: [consumer.consumerArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Kinesis.DescribeStreamConsumer(${consumer.LogicalId})`,
      )(function* (request?: DescribeStreamConsumerRequest) {
        return yield* describeStreamConsumer({
          ...request,
          ConsumerARN: yield* ConsumerARN,
        });
      });
    });
  }),
);
