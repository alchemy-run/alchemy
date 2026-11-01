import { partition } from "@distilled.cloud/aws/rules-engine/aws-functions";

/**
 * An AWS partition: the first segment after `arn:` in every ARN, e.g. `aws`,
 * `aws-cn`, `aws-us-gov` or `aws-eusc` (the AWS European Sovereign Cloud).
 */
export type Partition =
  | "aws"
  | "aws-cn"
  | "aws-us-gov"
  | "aws-iso"
  | "aws-iso-b"
  | "aws-iso-e"
  | "aws-iso-f"
  | "aws-eusc";

/**
 * The partition a region belongs to, from the `partitions.json` distilled's
 * endpoint rules resolve hosts with, so an ARN always names the partition its
 * endpoint is in. An unknown region falls back to `aws`, as the rules do.
 */
const partitionFor = (region: string) => partition(region)!;

/**
 * The partition a region belongs to, e.g. `partitionOf("eusc-de-east-1")` is
 * `"aws-eusc"`.
 */
export const partitionOf = (region: string): Partition => partitionFor(region).name as Partition;

/**
 * The DNS suffix of service endpoints in a region's partition, e.g.
 * `dnsSuffixOf("eusc-de-east-1")` is `"amazonaws.eu"`.
 */
export const dnsSuffixOf = (region: string): string => partitionFor(region).dnsSuffix;

/**
 * The region a global service is served from in a region's partition, e.g.
 * `globalRegionOf("eu-central-1")` is `"us-east-1"` and
 * `globalRegionOf("eusc-de-east-1")` is `"eusc-de-east-1"`.
 */
export const globalRegionOf = (region: string): string => partitionFor(region).implicitGlobalRegion;

/**
 * The ARN of an AWS managed IAM policy in `partition`, e.g.
 * `managedPolicyArn("aws-eusc", "service-role/AWSLambdaBasicExecutionRole")`.
 */
export const managedPolicyArn = (partition: Partition, name: string) =>
  `arn:${partition}:iam::aws:policy/${name}`;
