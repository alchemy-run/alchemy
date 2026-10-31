/**
 * The AWS partitions, mirrored from the `regionRegex`, `dnsSuffix` and
 * `implicitGlobalRegion` of each entry in botocore's `partitions.json`. A
 * region belongs to the first partition whose regex matches it; an unmatched
 * region falls back to `aws`, as the SDK endpoint rules do.
 */
const PARTITIONS = [
  {
    id: "aws",
    regionRegex: /^(us|eu|ap|sa|ca|me|af|il|mx)-\w+-\d+$/,
    dnsSuffix: "amazonaws.com",
    globalRegion: "us-east-1",
  },
  {
    id: "aws-cn",
    regionRegex: /^cn-\w+-\d+$/,
    dnsSuffix: "amazonaws.com.cn",
    globalRegion: "cn-northwest-1",
  },
  {
    id: "aws-us-gov",
    regionRegex: /^us-gov-\w+-\d+$/,
    dnsSuffix: "amazonaws.com",
    globalRegion: "us-gov-west-1",
  },
  {
    id: "aws-iso",
    regionRegex: /^us-iso-\w+-\d+$/,
    dnsSuffix: "c2s.ic.gov",
    globalRegion: "us-iso-east-1",
  },
  {
    id: "aws-iso-b",
    regionRegex: /^us-isob-\w+-\d+$/,
    dnsSuffix: "sc2s.sgov.gov",
    globalRegion: "us-isob-east-1",
  },
  {
    id: "aws-iso-e",
    regionRegex: /^eu-isoe-\w+-\d+$/,
    dnsSuffix: "cloud.adc-e.uk",
    globalRegion: "eu-isoe-west-1",
  },
  {
    id: "aws-iso-f",
    regionRegex: /^us-isof-\w+-\d+$/,
    dnsSuffix: "csp.hci.ic.gov",
    globalRegion: "us-isof-south-1",
  },
  {
    id: "aws-eusc",
    regionRegex: /^eusc-(de)-\w+-\d+$/,
    dnsSuffix: "amazonaws.eu",
    globalRegion: "eusc-de-east-1",
  },
] as const;

/**
 * An AWS partition: the first segment after `arn:` in every ARN, e.g. `aws`,
 * `aws-cn`, `aws-us-gov` or `aws-eusc` (the AWS European Sovereign Cloud).
 */
export type Partition = (typeof PARTITIONS)[number]["id"];

const partitionFor = (region: string) =>
  PARTITIONS.find((partition) => partition.regionRegex.test(region)) ?? PARTITIONS[0];

/**
 * The partition a region belongs to, e.g. `partitionOf("eusc-de-east-1")` is
 * `"aws-eusc"`.
 */
export const partitionOf = (region: string): Partition => partitionFor(region).id;

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
export const globalRegionOf = (region: string): string => partitionFor(region).globalRegion;

/**
 * The ARN of an AWS managed IAM policy in `partition`, e.g.
 * `managedPolicyArn("aws-eusc", "service-role/AWSLambdaBasicExecutionRole")`.
 */
export const managedPolicyArn = (partition: Partition, name: string) =>
  `arn:${partition}:iam::aws:policy/${name}`;
