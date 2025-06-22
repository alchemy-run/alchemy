import {
  GetResourcesCommand,
  ResourceGroupsTaggingAPIClient,
} from "@aws-sdk/client-resource-groups-tagging-api";
import {
  CreateBucketCommand,
  PutBucketTaggingCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { loadConfig } from "@smithy/node-config-provider";

export interface BootstrapS3Options {
  region?: string;
  prefix?: string;
  help?: boolean;
}

const BOOTSTRAP_TAG_KEY = "alchemy:bootstrap";
const BOOTSTRAP_TAG_VALUE = "s3-state-store";

/**
 * Generate a random suffix for bucket names to avoid conflicts
 */
function generateRandomSuffix(): string {
  return Math.random().toString(36).substring(2, 8);
}

/**
 * Find existing bootstrap bucket by checking tags using Resource Groups API
 */
async function findExistingBootstrapBucket(
  region: string,
  prefix: string,
): Promise<string | null> {
  try {
    const resourceGroupsClient = new ResourceGroupsTaggingAPIClient({ region });

    const result = await resourceGroupsClient.send(
      new GetResourcesCommand({
        ResourceTypeFilters: ["s3:bucket"],
        TagFilters: [
          {
            Key: BOOTSTRAP_TAG_KEY,
            Values: [BOOTSTRAP_TAG_VALUE],
          },
        ],
      }),
    );

    if (!result.ResourceTagMappingList) {
      return null;
    }

    // Find a bucket that matches our prefix
    for (const resource of result.ResourceTagMappingList) {
      if (resource.ResourceARN) {
        // Extract bucket name from ARN: arn:aws:s3:::bucket-name
        const bucketName = resource.ResourceARN.split(":::")[1];
        if (bucketName?.startsWith(prefix)) {
          return bucketName;
        }
      }
    }
  } catch (error: any) {
    console.error("Error finding bootstrap buckets:", error.message);
    return null;
  }

  return null;
}

/**
 * Create a new S3 bucket with bootstrap tags
 */
async function createBootstrapBucket(
  s3Client: S3Client,
  bucketName: string,
): Promise<void> {
  try {
    // Create the bucket
    const createCommand = new CreateBucketCommand({
      Bucket: bucketName,
    });

    await s3Client.send(createCommand);
    console.log(`✅ Created S3 bucket: ${bucketName}`);

    // Add bootstrap tags
    await s3Client.send(
      new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: {
          TagSet: [
            {
              Key: BOOTSTRAP_TAG_KEY,
              Value: BOOTSTRAP_TAG_VALUE,
            },
            {
              Key: "Purpose",
              Value: "Alchemy state storage",
            },
            {
              Key: "CreatedBy",
              Value: "alchemy-cli",
            },
          ],
        },
      }),
    );

    console.log("✅ Tagged bucket with bootstrap markers");
  } catch (error: any) {
    if (error.name === "BucketAlreadyExists") {
      throw new Error(
        `Bucket name '${bucketName}' is already taken. Please try again to generate a new random suffix.`,
      );
    } else if (error.name === "BucketAlreadyOwnedByYou") {
      console.log(`✅ Bucket ${bucketName} already exists and is owned by you`);

      // Still add tags if they're missing
      try {
        await s3Client.send(
          new PutBucketTaggingCommand({
            Bucket: bucketName,
            Tagging: {
              TagSet: [
                {
                  Key: BOOTSTRAP_TAG_KEY,
                  Value: BOOTSTRAP_TAG_VALUE,
                },
                {
                  Key: "Purpose",
                  Value: "Alchemy state storage",
                },
                {
                  Key: "CreatedBy",
                  Value: "alchemy-cli",
                },
              ],
            },
          }),
        );
        console.log("✅ Added bootstrap tags to existing bucket");
      } catch (tagError: any) {
        throw new Error(
          `Failed to tag existing bucket '${bucketName}': ${tagError.message}`,
        );
      }
    } else {
      throw error;
    }
  }
}

/**
 * Get the default AWS region from the current profile/configuration
 */
async function getDefaultRegion(): Promise<string> {
  try {
    const regionProvider = loadConfig({
      environmentVariableSelector: (env) =>
        env.AWS_REGION || env.AWS_DEFAULT_REGION,
      configFileSelector: (profile) => profile.region,
      default: "us-east-1",
    });

    return await regionProvider();
  } catch (_error) {
    return "us-east-1"; // Default fallback
  }
}

/**
 * Bootstrap S3 bucket for Alchemy state storage
 */
export async function bootstrapS3(options: BootstrapS3Options): Promise<void> {
  if (options.help) {
    console.log(`
Usage: alchemy bootstrap s3 [options]

Create an S3 bucket for Alchemy state storage with proper tagging.

Options:
  --region    AWS region (defaults to AWS profile default: us-east-1)
  --prefix    S3 bucket name prefix (default: alchemy-state)
  --help      Show this help message

Examples:
  alchemy bootstrap s3                                    # Use defaults
  alchemy bootstrap s3 --region us-west-2                # Specify region
  alchemy bootstrap s3 --prefix my-app-state             # Custom prefix
  alchemy bootstrap s3 --region eu-west-1 --prefix app   # Both options

The created bucket will be tagged with 'alchemy:bootstrap=s3-state-store' to
identify it for future bootstrap operations and avoid creating duplicates.
`);
    return;
  }

  const prefix = options.prefix || "alchemy-state";
  const region = options.region || (await getDefaultRegion());

  console.log("🚀 Bootstrapping S3 state storage...");
  console.log(`   Region: ${region}`);
  console.log(`   Prefix: ${prefix}`);

  // Initialize S3 client
  const s3Client = new S3Client({
    region,
  });

  try {
    // Check for existing bootstrap bucket
    const existingBucket = await findExistingBootstrapBucket(region, prefix);

    if (existingBucket) {
      console.log(`✅ Found existing bootstrap bucket: ${existingBucket}`);
      console.log("\n📝 To use this bucket in your alchemy.run.ts file:\n");
      console.log(`import { S3StateStore } from "alchemy/aws";`);
      console.log("\nconst stateStore = new S3StateStore(scope, {");
      console.log(`  bucketName: "${existingBucket}",`);
      console.log(`  region: "${region}",`);
      console.log("});\n");
      return;
    }

    // Generate a new bucket name with random suffix
    const bucketName = `${prefix}-${generateRandomSuffix()}`;
    console.log(`📦 Creating new bucket: ${bucketName}`);

    // Create the bucket
    await createBootstrapBucket(s3Client, bucketName);

    console.log("\n🎉 Bootstrap complete!");
    console.log("\n📝 To use this bucket in your alchemy.run.ts file:\n");
    console.log(`import { S3StateStore } from "alchemy/aws";`);
    console.log("\nconst stateStore = new S3StateStore(scope, {");
    console.log(`  bucketName: "${bucketName}",`);
    console.log(`  region: "${region}",`);
    console.log("});\n");
  } catch (error: any) {
    console.error(`❌ Failed to bootstrap S3: ${error.message}`);

    if (error.message?.includes("credentials")) {
      console.error("\n💡 Make sure your AWS credentials are configured:");
      console.error(`   - Run 'aws configure' to set up credentials`);
      console.error(
        "   - Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables",
      );
      console.error("   - Or use IAM roles if running on EC2/Lambda");
    }

    process.exit(1);
  }
}
