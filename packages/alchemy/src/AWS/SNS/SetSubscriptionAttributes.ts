import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Subscription } from "./Subscription.ts";

export interface SetSubscriptionAttributesRequest extends Omit<
  sns.SetSubscriptionAttributesInput,
  "SubscriptionArn"
> {}

/** @binding */
export interface SetSubscriptionAttributes extends Binding.Service<
  SetSubscriptionAttributes,
  "AWS.SNS.SetSubscriptionAttributes",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: SetSubscriptionAttributesRequest,
    ) => Effect.Effect<
      sns.SetSubscriptionAttributesResponse,
      sns.SetSubscriptionAttributesError
    >
  >
> {}
export const SetSubscriptionAttributes =
  Binding.Service<SetSubscriptionAttributes>(
    "AWS.SNS.SetSubscriptionAttributes",
  );
