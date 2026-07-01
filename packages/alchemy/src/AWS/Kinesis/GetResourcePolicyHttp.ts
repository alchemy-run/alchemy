import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  GetResourcePolicy,
  type GetResourcePolicyRequest,
} from "./GetResourcePolicy.ts";
import type { Stream } from "./Stream.ts";

export const GetResourcePolicyHttp = Layer.effect(
  GetResourcePolicy,
  Effect.gen(function* () {
    const getResourcePolicy = yield* Kinesis.getResourcePolicy;

    return Effect.fn(function* (stream: Stream) {
      const ResourceARN = yield* stream.streamArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Kinesis.GetResourcePolicy(${stream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["kinesis:GetResourcePolicy"],
                  Resource: [stream.streamArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Kinesis.GetResourcePolicy(${stream.LogicalId})`)(
        function* (request?: GetResourcePolicyRequest) {
          return yield* getResourcePolicy({
            ...request,
            ResourceARN: yield* ResourceARN,
          });
        },
      );
    });
  }),
);
