import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { AccountID } from "../account.ts";
import type { RegionID } from "../region.ts";

export type BucketName = string;
export type BucketArn = `arn:aws:s3:::${string}`;

export interface BucketProps {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * Must be lowercase and between 3-63 characters.
   */
  bucketName?: string;
  /**
   * Indicates whether this bucket has Object Lock enabled.
   * Once enabled, cannot be disabled.
   */
  objectLockEnabled?: boolean;
  /**
   * Whether to delete all objects when the bucket is destroyed.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Tags to apply to the bucket.
   */
  tags?: Record<string, Input<string>>;
}

export interface BucketAttrs<Props extends Input.Resolve<BucketProps>> {
  /**
   * Name of the bucket.
   */
  bucketName: Props["bucketName"] extends string ? Props["bucketName"] : string;
  /**
   * ARN of the bucket.
   */
  bucketArn: `arn:aws:s3:::${this["bucketName"]}`;
  /**
   * Domain name of the bucket (e.g., bucket-name.s3.amazonaws.com).
   */
  bucketDomainName: `${this["bucketName"]}.s3.amazonaws.com`;
  /**
   * Regional domain name of the bucket.
   */
  bucketRegionalDomainName: `${this["bucketName"]}.s3.${RegionID}.amazonaws.com`;
  /**
   * AWS region where the bucket is located.
   */
  region: RegionID;
  /**
   * AWS account ID that owns the bucket.
   */
  accountId: AccountID;
}

export const Bucket = Resource<{
  <const ID extends string, const Props extends BucketProps>(
    id: ID,
    props?: Props,
  ): Bucket<ID, Props>;
}>("AWS.S3.Bucket");

export interface Bucket<
  ID extends string = string,
  Props extends BucketProps = BucketProps,
> extends Resource<
  "AWS.S3.Bucket",
  ID,
  Props,
  BucketAttrs<Input.Resolve<Props>>,
  Bucket
> {}
