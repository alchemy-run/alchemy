import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { PolicyDocument } from "../iam/index.ts";
import type { BucketName } from "./bucket.ts";

export interface BucketPolicyProps {
  /**
   * Name of the bucket to attach the policy to.
   */
  bucket: Input<BucketName>;
  /**
   * The policy document to apply.
   */
  policy: Input<PolicyDocument>;
}

export interface BucketPolicyAttrs<
  Props extends Input.Resolve<BucketPolicyProps>,
> {
  /**
   * Name of the bucket the policy is attached to.
   */
  bucket: Props["bucket"];
}

export const BucketPolicy = Resource<{
  <const ID extends string, const Props extends BucketPolicyProps>(
    id: ID,
    props: Props,
  ): BucketPolicy<ID, Props>;
}>("AWS.S3.BucketPolicy");

export interface BucketPolicy<
  ID extends string = string,
  Props extends BucketPolicyProps = BucketPolicyProps,
> extends Resource<
  "AWS.S3.BucketPolicy",
  ID,
  Props,
  BucketPolicyAttrs<Input.Resolve<Props>>,
  BucketPolicy
> {}
