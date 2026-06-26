import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeStreamSummary,
  type DescribeStreamSummaryRequest,
} from "./DescribeStreamSummary.ts";
import type { Stream } from "./Stream.ts";

export const DescribeStreamSummaryHttp = Layer.effect(
  DescribeStreamSummary,
  Effect.gen(function* () {
    const describeStreamSummary = yield* Kinesis.describeStreamSummary;

    return Effect.fn(function* (stream: Stream) {
      const StreamARN = yield* stream.streamArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.DescribeStreamSummary(${stream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["kinesis:DescribeStreamSummary"],
                  Resource: [stream.streamArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Kinesis.DescribeStreamSummary(${stream.LogicalId})`,
      )(function* (request?: DescribeStreamSummaryRequest) {
        return yield* describeStreamSummary({
          ...request,
          StreamARN: yield* StreamARN,
        });
      });
    });
  }),
);
