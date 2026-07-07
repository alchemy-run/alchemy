import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";
import {
  PutDataProtectionPolicy,
  type PutDataProtectionPolicyRequest,
} from "./PutDataProtectionPolicy.ts";

export const PutDataProtectionPolicyHttp = Layer.effect(
  PutDataProtectionPolicy,
  Effect.gen(function* () {
    const putDataProtectionPolicy = yield* sns.putDataProtectionPolicy;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.PutDataProtectionPolicy(${topic}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sns:PutDataProtectionPolicy"],
                  Resource: [topic.topicArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SNS.PutDataProtectionPolicy(${topic.LogicalId})`)(
        function* (request: PutDataProtectionPolicyRequest) {
          return yield* putDataProtectionPolicy({
            ...request,
            ResourceArn: yield* TopicArn,
          });
        },
      );
    });
  }),
);
