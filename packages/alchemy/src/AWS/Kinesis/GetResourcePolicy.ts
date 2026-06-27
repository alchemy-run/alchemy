import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetResourcePolicyRequest extends Omit<
  Kinesis.GetResourcePolicyInput,
  "ResourceARN"
> {}

/** @binding */
export interface GetResourcePolicy extends Binding.Service<
  GetResourcePolicy,
  "AWS.Kinesis.GetResourcePolicy",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: GetResourcePolicyRequest,
    ) => Effect.Effect<
      Kinesis.GetResourcePolicyOutput,
      Kinesis.GetResourcePolicyError
    >
  >
> {}

export const GetResourcePolicy = Binding.Service<GetResourcePolicy>(
  "AWS.Kinesis.GetResourcePolicy",
);
