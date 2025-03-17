import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetBucketAclCommand,
  GetBucketLocationCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  NoSuchBucket,
  PutBucketTaggingCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ignore } from "../error";
import { Resource } from "../resource";

export interface BucketProps {
  bucketName: string;
  tags?: Record<string, string>;
}

export interface BucketOutput extends BucketProps {
  id: string; // Same as bucketName for AWS
  arn: string;
  bucketDomainName: string; // Format: bucket-name.s3.amazonaws.com
  bucketRegionalDomainName?: string; // Format: bucket-name.s3.region.amazonaws.com
  hostedZoneId?: string; // S3 hosted zone ID for the region
  region?: string; // AWS Region where bucket resides
  websiteEndpoint?: string; // Only if website hosting is enabled
  websiteDomain?: string; // Only if website hosting is enabled
  versioningEnabled?: boolean;
  acl?: string;
}

export class Bucket extends Resource(
  "s3::Bucket",
  async (ctx, props: BucketProps) => {
    const client = new S3Client({});

    if (ctx.event === "delete") {
      await ignore(NoSuchBucket.name, () =>
        client.send(
          new DeleteBucketCommand({
            Bucket: props.bucketName,
          }),
        ),
      );
      return props;
    } else {
      try {
        // Check if bucket exists
        await client.send(
          new HeadBucketCommand({
            Bucket: props.bucketName,
          }),
        );

        // Update tags if they changed and bucket exists
        if (ctx.event === "update" && props.tags) {
          await client.send(
            new PutBucketTaggingCommand({
              Bucket: props.bucketName,
              Tagging: {
                TagSet: Object.entries(props.tags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              },
            }),
          );
        }
      } catch (error: any) {
        if (error.name === "NotFound") {
          // Create bucket if it doesn't exist
          await client.send(
            new CreateBucketCommand({
              Bucket: props.bucketName,
              // Add tags during creation if specified
              ...(props.tags && {
                Tagging: {
                  TagSet: Object.entries(props.tags).map(([Key, Value]) => ({
                    Key,
                    Value,
                  })),
                },
              }),
            }),
          );
        } else {
          throw error;
        }
      }

      // Get bucket details
      const [locationResponse, versioningResponse, aclResponse] =
        await Promise.all([
          client.send(
            new GetBucketLocationCommand({ Bucket: props.bucketName }),
          ),
          client.send(
            new GetBucketVersioningCommand({ Bucket: props.bucketName }),
          ),
          client.send(new GetBucketAclCommand({ Bucket: props.bucketName })),
        ]);

      const region = locationResponse.LocationConstraint || "us-east-1";

      // Get tags if they exist
      let tags = props.tags;
      if (!tags) {
        try {
          const taggingResponse = await client.send(
            new GetBucketTaggingCommand({ Bucket: props.bucketName }),
          );
          tags = Object.fromEntries(
            taggingResponse.TagSet?.map(({ Key, Value }) => [Key, Value]) || [],
          );
        } catch (error: any) {
          if (error.name !== "NoSuchTagSet") {
            throw error;
          }
        }
      }

      const output: BucketOutput = {
        bucketName: props.bucketName,
        id: props.bucketName,
        arn: `arn:aws:s3:::${props.bucketName}`,
        bucketDomainName: `${props.bucketName}.s3.amazonaws.com`,
        bucketRegionalDomainName: `${props.bucketName}.s3.${region}.amazonaws.com`,
        region,
        hostedZoneId: getHostedZoneId(region),
        versioningEnabled: versioningResponse.Status === "Enabled",
        acl: aclResponse.Grants?.[0]?.Permission?.toLowerCase(),
        ...(tags && { tags }),
      };

      return output;
    }
  },
) {}

// Helper function to get S3 hosted zone IDs by region
function getHostedZoneId(region: string): string {
  const hostedZoneIds: Record<string, string> = {
    "us-east-1": "Z3AQBSTGFYJSTF",
    "us-east-2": "Z2O1EMRO9K5GLX",
    "us-west-1": "Z2F56UZL2M1ACD",
    "us-west-2": "Z3BJ6K6RIION7M",
    "af-south-1": "Z11KHD8FBVPUYU",
    "ap-east-1": "ZNB98KWMFR0R6",
    "ap-south-1": "Z11RGJOFQNVJUP",
    "ap-northeast-1": "Z2M4EHUR26P7ZW",
    "ap-northeast-2": "Z3W03O7B5YMIYP",
    "ap-northeast-3": "Z2YQB5RD63NC85",
    "ap-southeast-1": "Z3O0J2DXBE1FTB",
    "ap-southeast-2": "Z1WCIGYICN2BYD",
    "ca-central-1": "Z1QDHH18159H29",
    "eu-central-1": "Z21DNDUVLTQW6Q",
    "eu-west-1": "Z1BKCTXD74EZPE",
    "eu-west-2": "Z3GKZC51ZF0DB4",
    "eu-west-3": "Z3R1K369G5AVDG",
    "eu-north-1": "Z3BAZG2TWCNX0D",
    "eu-south-1": "Z30OZKI7KPW7MI",
    "me-south-1": "Z1MPMWCPA7YB62",
    "sa-east-1": "Z7KQH4QJS55SO",
  };
  return hostedZoneIds[region] || "Z3AQBSTGFYJSTF"; // Default to us-east-1 if region not found
}
