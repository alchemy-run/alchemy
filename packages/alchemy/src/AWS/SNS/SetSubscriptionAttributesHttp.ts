import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Subscription } from "./Subscription.ts";
import {
  SetSubscriptionAttributes,
  type SetSubscriptionAttributesRequest,
} from "./SetSubscriptionAttributes.ts";

export const SetSubscriptionAttributesHttp = Layer.effect(
  SetSubscriptionAttributes,
  Effect.gen(function* () {
    const setSubscriptionAttributes = yield* sns.setSubscriptionAttributes;

    return Effect.fn(function* (subscription: Subscription) {
      const SubscriptionArn = yield* subscription.subscriptionArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.SetSubscriptionAttributes(${subscription}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sns:SetSubscriptionAttributes"],
                  Resource: [subscription.topicArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.SNS.SetSubscriptionAttributes(${subscription.LogicalId})`,
      )(function* (request: SetSubscriptionAttributesRequest) {
        return yield* setSubscriptionAttributes({
          ...request,
          SubscriptionArn: yield* SubscriptionArn,
        });
      });
    });
  }),
);
