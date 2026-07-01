import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListSubscriptionsRequest extends sns.ListSubscriptionsInput {}

/** @binding */
export interface ListSubscriptions extends Binding.Service<
  ListSubscriptions,
  "AWS.SNS.ListSubscriptions",
  () => Effect.Effect<
    (
      request?: ListSubscriptionsRequest,
    ) => Effect.Effect<
      sns.ListSubscriptionsResponse,
      sns.ListSubscriptionsError
    >
  >
> {}

export const ListSubscriptions = Binding.Service<ListSubscriptions>(
  "AWS.SNS.ListSubscriptions",
);
