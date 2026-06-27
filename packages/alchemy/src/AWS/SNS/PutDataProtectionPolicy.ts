import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface PutDataProtectionPolicyRequest extends Omit<
  sns.PutDataProtectionPolicyInput,
  "ResourceArn"
> {}

/** @binding */
export interface PutDataProtectionPolicy extends Binding.Service<
  PutDataProtectionPolicy,
  "AWS.SNS.PutDataProtectionPolicy",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PutDataProtectionPolicyRequest,
    ) => Effect.Effect<
      sns.PutDataProtectionPolicyResponse,
      sns.PutDataProtectionPolicyError
    >
  >
> {}
export const PutDataProtectionPolicy = Binding.Service<PutDataProtectionPolicy>(
  "AWS.SNS.PutDataProtectionPolicy",
);
