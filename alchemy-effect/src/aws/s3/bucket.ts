import type { Input } from "../../input.ts";
import { Resource } from "../../resource.ts";
import type { RegionID } from "../region.ts";

/**
 * A branded type representing an S3 Bucket name.
 * Bucket names must be globally unique within a partition and follow specific naming rules:
 * - Length: 3-63 characters
 * - Must start with a lowercase letter or number
 * - Must end with a lowercase letter or number
 * - May contain lowercase letters, numbers, hyphens, and periods
 * - Must not match the S3 Express directory bucket pattern
 */
export type BucketName<S extends string = string> = S & {
  readonly __brand: "BucketName";
};

/**
 * Creates a branded BucketName from a string value.
 */
export const BucketName = <const S extends string>(value: S): BucketName<S> =>
  value as BucketName<S>;

/**
 * A branded type representing an S3 Bucket ARN.
 * Format: `arn:aws:s3:::bucketname`
 * Note: S3 bucket ARNs do not include region or account ID (global resource within partition).
 */
export type BucketArn<Name extends string = string> = `arn:aws:s3:::${Name}`;

/**
 * Creates a branded BucketArn from a bucket name.
 */
export const BucketArn = <const Name extends string>(
  bucketName: Name,
): BucketArn<Name> => `arn:aws:s3:::${bucketName}`;

/**
 * Constructs an S3 Bucket resource.
 *
 * S3 Buckets are the fundamental containers for storing objects in Amazon S3.
 * Each bucket has a globally unique name within a partition and serves as
 * the namespace for objects stored within it.
 *
 * @example
 * ```ts
 * const bucket = Bucket("my-bucket", {
 *   bucket: "my-unique-bucket-name",
 *   tags: { Environment: "production" },
 * });
 * ```
 *
 * @example With prefix-based naming
 * ```ts
 * const bucket = Bucket("app-data", {
 *   bucketPrefix: "myapp-data-",
 *   objectLockEnabled: true,
 *   forceDestroy: false,
 * });
 * ```
 */
export const Bucket = Resource<{
  <const ID extends string, const Props extends BucketProps>(
    id: ID,
    props: Props,
  ): Bucket<ID, Props>;
}>("AWS.S3.Bucket");

/**
 * An S3 Bucket resource instance.
 *
 * @typeParam ID - The logical ID of the bucket within the stack
 * @typeParam Props - The input properties for the bucket configuration
 */
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

/**
 * Input properties for creating an S3 Bucket.
 */
export interface BucketProps {
  /**
   * The name of the bucket.
   *
   * Must be between 3-63 characters, lowercase alphanumeric, and may contain hyphens and periods.
   * Must be globally unique across all AWS accounts in the same partition.
   * Must not match the directory bucket name pattern (`[bucket_name]--[azid]--x-s3`).
   *
   * Conflicts with `bucketPrefix`. If neither `bucket` nor `bucketPrefix` is provided,
   * a name will be automatically generated.
   *
   * **Lifecycle:** Causes replacement if changed. Bucket names cannot be changed after creation.
   */
  bucket?: string;

  /**
   * Creates a unique bucket name beginning with the specified prefix.
   *
   * Limited to 37 characters (63 minus 26-character unique suffix).
   * A deterministic unique suffix will be appended based on the stack name, stage, and resource ID.
   *
   * Conflicts with `bucket`. If neither `bucket` nor `bucketPrefix` is provided,
   * a name will be automatically generated.
   *
   * **Lifecycle:** Causes replacement if changed. The prefix is used to generate the bucket name at creation time.
   */
  bucketPrefix?: string;

  /**
   * Indicates whether this bucket has Object Lock configuration enabled.
   *
   * Object Lock can only be enabled at bucket creation time and cannot be disabled once enabled.
   * When enabled, versioning is automatically enabled on the bucket.
   *
   * Object Lock provides WORM (Write Once Read Many) protection for objects, allowing you to
   * store objects using a write-once-read-many model. This helps prevent objects from being
   * deleted or overwritten for a fixed amount of time or indefinitely.
   *
   * **Lifecycle:** Causes replacement if changed. Object Lock can only be set at bucket creation time.
   *
   * @default false
   */
  objectLockEnabled?: boolean;

  /**
   * If true, all objects (including any locked objects) will be deleted from the bucket
   * when the bucket is destroyed, allowing the bucket to be deleted without error.
   *
   * When enabled, the delete operation will:
   * - Delete all object versions and delete markers
   * - Attempt to remove legal holds on objects (requires `s3:PutObjectLegalHold` permission)
   * - Bypass governance-mode retention (requires `s3:BypassGovernanceRetention` permission)
   *
   * Note: Objects with compliance-mode retention cannot be deleted until the retention period expires.
   * These objects are not recoverable after deletion.
   *
   * **Lifecycle:** Can be updated without replacement. This is a client-side property that only affects deletion behavior.
   *
   * @default false
   */
  forceDestroy?: boolean;

  /**
   * Map of tags to assign to the bucket.
   *
   * Tags are key-value pairs that help you organize and categorize your buckets.
   * Uses ABAC-compatible tagging APIs (`s3:TagResource`) when the principal has permission,
   * otherwise falls back to bucket-level tagging APIs (`s3:PutBucketTagging`).
   *
   * **Lifecycle:** Can be updated without replacement. Tags can be added, modified, or removed at any time.
   */
  tags?: Input<Record<string, Input<string>>>;
}

/**
 * Output attributes for an S3 Bucket.
 *
 * @typeParam Props - The resolved input properties used to create the bucket
 */
export interface BucketAttrs<Props extends Input.Resolve<BucketProps>> {
  /**
   * The bucket name (same as `bucket`).
   * Used as the primary identifier for the resource.
   */
  id: string;

  /**
   * The name of the bucket.
   * If `bucket` was provided, this is that exact value.
   * If `bucketPrefix` was provided, this includes the prefix plus the generated suffix.
   * If neither was provided, this is the auto-generated name.
   */
  bucket: Props["bucket"] extends string ? Props["bucket"] : string;

  /**
   * ARN of the bucket in format `arn:aws:s3:::bucketname`.
   * S3 bucket ARNs do not include region or account ID (global resource within partition).
   */
  arn: BucketArn<this["bucket"]>;

  /**
   * The bucket domain name in format `bucketname.s3.amazonaws.com`.
   * This is the global endpoint for accessing the bucket.
   */
  bucketDomainName: `${this["bucket"]}.s3.amazonaws.com`;

  /**
   * The prefix used to create the bucket name, if `bucketPrefix` was specified.
   * Undefined if an explicit `bucket` name was provided or auto-generated.
   */
  bucketPrefix: Props["bucketPrefix"] extends string
    ? Props["bucketPrefix"]
    : undefined;

  /**
   * The AWS region where the bucket resides.
   * Buckets cannot be moved between regions after creation.
   */
  bucketRegion: RegionID;

  /**
   * The region-specific domain name in format `bucketname.s3.region.amazonaws.com`.
   * Using the regional endpoint provides better performance and is recommended for
   * new bucket accesses immediately after creation (avoids DNS propagation delays).
   */
  bucketRegionalDomainName: `${this["bucket"]}.s3.${this["bucketRegion"]}.amazonaws.com`;

  /**
   * The Route 53 Hosted Zone ID for this bucket's region.
   * Used for creating Route 53 alias records pointing to the bucket.
   */
  hostedZoneId: string;

  /**
   * Whether Object Lock is enabled on the bucket.
   * Will be `true` if Object Lock was enabled at bucket creation, otherwise `false`.
   */
  objectLockEnabled: Props["objectLockEnabled"] extends true ? true : boolean;
}
