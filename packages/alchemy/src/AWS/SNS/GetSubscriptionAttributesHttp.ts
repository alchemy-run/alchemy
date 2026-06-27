import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Subscription } from "./Subscription.ts";
import {
  GetSubscriptionAttributes,
  type GetSubscriptionAttributesRequest,
} from "./GetSubscriptionAttributes.ts";

export const GetSubscriptionAttributesHttp = Layer.effect(
  GetSubscriptionAttributes,
  Effect.gen(function* () {
    const getSubscriptionAttributes = yield* sns.getSubscriptionAttributes;

    return Effect.fn(function* (subscription: Subscription) {
      const SubscriptionArn = yield* subscription.subscriptionArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.GetSubscriptionAttributes(${subscription}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sns:GetSubscriptionAttributes"],
                  Resource: [subscription.topicArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.SNS.GetSubscriptionAttributes(${subscription.LogicalId})`,
      )(function* (request?: GetSubscriptionAttributesRequest) {
        return yield* getSubscriptionAttributes({
          ...request,
          SubscriptionArn: yield* SubscriptionArn,
        });
      });
    });
  }),
);
