import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeStream,
  type DescribeStreamRequest,
} from "./DescribeStream.ts";
import type { Stream } from "./Stream.ts";

export const DescribeStreamHttp = Layer.effect(
  DescribeStream,
  Effect.gen(function* () {
    const describeStream = yield* Kinesis.describeStream;

    return Effect.fn(function* (stream: Stream) {
      const StreamARN = yield* stream.streamArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.DescribeStream(${stream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["kinesis:DescribeStream"],
                  Resource: [stream.streamArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Kinesis.DescribeStream(${stream.LogicalId})`)(
        function* (request?: DescribeStreamRequest) {
          return yield* describeStream({
            ...request,
            StreamARN: yield* StreamARN,
          });
        },
      );
    });
  }),
);
