import type { PolicyStatement } from "@alchemy.run/aws/IAM/Policy";
import type * as S3 from "@alchemy.run/aws/S3";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { account } from "../Credentials.ts";
import { Disk, type DiskProps } from "../Disk.ts";

/**
 * The IAM role Archil assumes to reach your bucket, per Archil region.
 * @see https://docs.archil.com/data-sources/s3-object-storage
 */
export const ARCHIL_S3_PRINCIPALS: Record<string, string> = {
  "aws-us-east-1": "arn:aws:iam::904233114299:role/archil-s3.prod.us-east-1",
  "aws-us-east-2": "arn:aws:iam::787372716928:role/archil-s3.prod.aws.us-east-2",
  "aws-us-west-2": "arn:aws:iam::795289710871:role/archil-s3.prod.aws.us-west-2",
  "aws-eu-west-1": "arn:aws:iam::794252461707:role/archil-s3.prod.aws.eu-west-1",
  "gcp-us-central1": "arn:aws:iam::025016447135:role/archil-s3.prod.gcp.us-central1",
};

/** The Archil organization isn't configured, so the bucket policy can't be scoped to it. */
export class ArchilOrganizationRequired extends Data.TaggedError("Archil.OrganizationRequired")<{
  readonly message: string;
}> {}

/** An Archil region with no published S3 principal. */
export class ArchilRegionUnsupported extends Data.TaggedError("Archil.RegionUnsupported")<{
  readonly region: string;
  readonly message: string;
}> {}

export interface S3DiskProps extends Omit<DiskProps, "storage"> {
  /** The bucket the disk keeps its files in. */
  bucket: S3.Bucket | Effect.Effect<S3.Bucket, any, any>;
  /** Prefix within the bucket, e.g. `"datasets/"`. */
  prefix?: string;
}

/**
 * The bucket-policy statements that let Archil's role for `region` read and
 * write `bucketArn`, only on behalf of disks in `organization`.
 */
export const archilBucketStatements = (input: {
  readonly region: string;
  readonly organization: string;
  readonly bucketArn: string;
  readonly prefix?: string;
}): PolicyStatement[] => {
  const principal = ARCHIL_S3_PRINCIPALS[input.region]!;
  const condition = {
    StringEquals: { "aws:PrincipalTag/archilAccountId": input.organization },
  };
  const objects = `${input.bucketArn}/${input.prefix ?? ""}*`;
  return [
    {
      Sid: "ArchilList",
      Effect: "Allow",
      Principal: { AWS: principal },
      Action: ["s3:ListBucket"],
      Resource: input.bucketArn,
      Condition: condition,
    },
    {
      Sid: "ArchilObjects",
      Effect: "Allow",
      Principal: { AWS: principal },
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      Resource: objects,
      Condition: condition,
    },
  ];
};

/**
 * An Archil disk that keeps its files in your own S3 bucket, with no access
 * keys anywhere: the bucket's policy trusts Archil's IAM role for your
 * region, only on behalf of disks in your Archil organization. The disk's
 * files are ordinary objects in the bucket, so any S3 tool can read them.
 *
 * Set your Archil organization id in your profile (`alchemy profile edit
 * --add Archil`) or as `ARCHIL_ORGANIZATION`; the policy can't be scoped
 * without it.
 * @see https://docs.archil.com/data-sources/s3-object-storage
 *
 * ### Creating a Disk on Your Bucket
 * **Example:** A dataset disk on an S3 bucket
 * ```typescript
 * import * as ArchilAWS from "@alchemy.run/archil/AWS";
 *
 * export const Store = AWS.S3.Bucket("Store", {});
 * export const Dataset = ArchilAWS.S3Disk("Dataset", { bucket: Store, prefix: "datasets/" });
 * ```
 *
 * @primitive
 * @product S3 Disk
 */
export const S3Disk = (id: string, props: S3DiskProps) =>
  Effect.gen(function* () {
    const { bucket: bucketRef, prefix, ...diskProps } = props;
    const bucket = Effect.isEffect(bucketRef) ? yield* bucketRef : bucketRef;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const { region, organization } = yield* account;
      if (!ARCHIL_S3_PRINCIPALS[region]) {
        return yield* new ArchilRegionUnsupported({
          region,
          message: `Archil publishes no S3 principal for ${region}.`,
        });
      }
      if (!organization) {
        return yield* new ArchilOrganizationRequired({
          message:
            "ArchilAWS.S3Disk scopes the bucket policy to your Archil organization. Set it with `alchemy profile edit --add Archil` or ARCHIL_ORGANIZATION.",
        });
      }
      yield* bucket.bind(`Archil(${id})`, {
        policyStatements: Output.map(bucket.bucketArn, (bucketArn) =>
          archilBucketStatements({ region, organization, bucketArn, prefix }),
        ),
      });
    }
    return yield* Disk(id, {
      ...diskProps,
      storage: { type: "s3", bucketName: bucket.bucketName, bucketPrefix: prefix },
    });
  });
