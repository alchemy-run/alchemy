import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Subscription } from "./Subscription.ts";
import {
  ConfirmSubscription,
  type ConfirmSubscriptionRequest,
} from "./ConfirmSubscription.ts";

export const ConfirmSubscriptionHttp = Layer.effect(
  ConfirmSubscription,
  Effect.gen(function* () {
    const confirmSubscription = yield* sns.confirmSubscription;

    return Effect.fn(function* (subscription: Subscription) {
      const TopicArn = yield* subscription.topicArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.ConfirmSubscription(${subscription}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sns:ConfirmSubscription"],
                  Resource: [subscription.topicArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.SNS.ConfirmSubscription(${subscription.LogicalId})`,
      )(function* (request: ConfirmSubscriptionRequest) {
        return yield* confirmSubscription({
          ...request,
          TopicArn: yield* TopicArn,
        });
      });
    });
  }),
);
