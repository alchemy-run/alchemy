import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface GetDataProtectionPolicyRequest extends Omit<
  sns.GetDataProtectionPolicyInput,
  "ResourceArn"
> {}

/** @binding */
export interface GetDataProtectionPolicy extends Binding.Service<
  GetDataProtectionPolicy,
  "AWS.SNS.GetDataProtectionPolicy",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: GetDataProtectionPolicyRequest,
    ) => Effect.Effect<
      sns.GetDataProtectionPolicyResponse,
      sns.GetDataProtectionPolicyError
    >
  >
> {}
export const GetDataProtectionPolicy = Binding.Service<GetDataProtectionPolicy>(
  "AWS.SNS.GetDataProtectionPolicy",
);
