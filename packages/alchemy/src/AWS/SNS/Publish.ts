import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface PublishRequest extends Omit<
  sns.PublishInput,
  "TopicArn" | "TargetArn" | "PhoneNumber"
> {}

/** @binding */
export interface Publish extends Binding.Service<
  Publish,
  "AWS.SNS.Publish",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishRequest,
    ) => Effect.Effect<sns.PublishResponse, sns.PublishError>
  >
> {}

export const Publish = Binding.Service<Publish>("AWS.SNS.Publish");
