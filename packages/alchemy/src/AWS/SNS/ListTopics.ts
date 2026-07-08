import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListTopicsRequest extends sns.ListTopicsInput {}

/** @binding */
export interface ListTopics extends Binding.Service<
  ListTopics,
  "AWS.SNS.ListTopics",
  () => Effect.Effect<
    (
      request?: ListTopicsRequest,
    ) => Effect.Effect<sns.ListTopicsResponse, sns.ListTopicsError>
  >
> {}

export const ListTopics = Binding.Service<ListTopics>("AWS.SNS.ListTopics");
