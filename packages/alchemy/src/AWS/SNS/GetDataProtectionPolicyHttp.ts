import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";
import {
  GetDataProtectionPolicy,
  type GetDataProtectionPolicyRequest,
} from "./GetDataProtectionPolicy.ts";

export const GetDataProtectionPolicyHttp = Layer.effect(
  GetDataProtectionPolicy,
  Effect.gen(function* () {
    const getDataProtectionPolicy = yield* sns.getDataProtectionPolicy;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.GetDataProtectionPolicy(${topic}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sns:GetDataProtectionPolicy"],
                  Resource: [topic.topicArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SNS.GetDataProtectionPolicy(${topic.LogicalId})`)(
        function* (request?: GetDataProtectionPolicyRequest) {
          return yield* getDataProtectionPolicy({
            ...request,
            ResourceArn: yield* TopicArn,
          });
        },
      );
    });
  }),
);
