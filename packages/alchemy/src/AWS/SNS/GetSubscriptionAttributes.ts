import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Subscription } from "./Subscription.ts";

export interface GetSubscriptionAttributesRequest extends Omit<
  sns.GetSubscriptionAttributesInput,
  "SubscriptionArn"
> {}

/** @binding */
export interface GetSubscriptionAttributes extends Binding.Service<
  GetSubscriptionAttributes,
  "AWS.SNS.GetSubscriptionAttributes",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request?: GetSubscriptionAttributesRequest,
    ) => Effect.Effect<
      sns.GetSubscriptionAttributesResponse,
      sns.GetSubscriptionAttributesError
    >
  >
> {}
export const GetSubscriptionAttributes =
  Binding.Service<GetSubscriptionAttributes>(
    "AWS.SNS.GetSubscriptionAttributes",
  );
