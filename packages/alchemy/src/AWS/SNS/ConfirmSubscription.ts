import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Subscription } from "./Subscription.ts";

export interface ConfirmSubscriptionRequest extends Omit<
  sns.ConfirmSubscriptionInput,
  "TopicArn"
> {}

/** @binding */
export interface ConfirmSubscription extends Binding.Service<
  ConfirmSubscription,
  "AWS.SNS.ConfirmSubscription",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: ConfirmSubscriptionRequest,
    ) => Effect.Effect<
      sns.ConfirmSubscriptionResponse,
      sns.ConfirmSubscriptionError
    >
  >
> {}
export const ConfirmSubscription = Binding.Service<ConfirmSubscription>(
  "AWS.SNS.ConfirmSubscription",
);
