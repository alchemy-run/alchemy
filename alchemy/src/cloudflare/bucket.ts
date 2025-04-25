import { AwsClient } from "aws4fetch";
import type { Context } from "../context.js";
import { Resource } from "../resource.js";
import type { Secret } from "../secret.js";
import { CloudflareApiError, handleApiError } from "./api-error.js";
import { CloudflareApi, createCloudflareApi } from "./api.js";

/**
 * Properties for creating or updating an R2 Bucket
 */
export interface BucketProps {
  /**
   * Name of the bucket
   * Names can only contain lowercase letters (a-z), numbers (0-9), and hyphens (-)
   * Cannot begin or end with a hyphen
   *
   * @default - the id of the resource
   */
  name?: string;

  /**
   * Optional location hint for the bucket
   * Indicates the primary geographical location data will be accessed from
   */
  locationHint?: string;

  /**
   * Optional jurisdiction for the bucket
   * Determines the regulatory jurisdiction the bucket data falls under
   */
  jurisdiction?: "default" | "eu" | "fedramp";

  /**
   * Whether to allow public access through the r2.dev subdomain
   * Only for development purposes - use custom domains for production
   */
  allowPublicAccess?: boolean;

  /**
   * Whether to delete the bucket.
   * If set to false, the bucket will remain but the resource will be removed from state
   *
   * @default true
   */
  delete?: boolean;

  /**
   * Whether to empty the bucket and delete all objects during resource deletion
   * @default false
   */
  empty?: boolean;

  /**
   * API Token to use for the bucket
   */
  apiToken?: Secret;

  /**
   * API Key to use for the bucket
   */
  apiKey?: Secret;

  /**
   * Email to use for the bucket
   */
  email?: string;

  /**
   * Account ID to use for the bucket
   */
  accountId?: string;

  /**
   * Access Key to use for the bucket
   */
  accessKey?: Secret;

  /**
   * Secret Access Key to use for the bucket
   */
  secretAccessKey?: Secret;
}

/**
 * Output returned after R2 Bucket creation/update
 */
export interface R2Bucket
  extends Resource<"cloudflare::R2Bucket">,
    BucketProps {
  /**
   * Resource type identifier
   */
  type: "r2_bucket";

  /**
   * The name of the bucket
   */
  name: string;

  /**
   * Location of the bucket
   */
  location: string;

  /**
   * Time at which the bucket was created
   */
  creationDate: Date;
}

/**
 * Creates and manages Cloudflare R2 Buckets for object storage.
 *
 * R2 Buckets provide S3-compatible object storage with automatic data replication
 * across multiple regions for high availability and durability.
 *
 * @example
 * // Create a basic R2 bucket with default settings
 * const basicBucket = await R2Bucket("my-app-data", {
 *   name: "my-app-data"
 * });
 *
 * @example
 * // Create a bucket with location hint for optimal performance
 * const euBucket = await R2Bucket("eu-user-data", {
 *   name: "eu-user-data",
 *   locationHint: "eu",
 *   jurisdiction: "eu"
 * });
 *
 * @example
 * // Create a development bucket with public access enabled
 * const publicBucket = await R2Bucket("public-assets", {
 *   name: "public-assets",
 *   allowPublicAccess: true
 * });
 *
 * @example
 * // Create a FedRAMP compliant bucket for government workloads
 * const fedRampBucket = await R2Bucket("gov-data", {
 *   name: "gov-data",
 *   jurisdiction: "fedramp"
 * });
 *
 * @example
 * // Create a bucket that will be automatically emptied when deleted
 * // This will delete all objects in the bucket before deleting the bucket itself
 * const temporaryBucket = await R2Bucket("temp-storage", {
 *   name: "temp-storage",
 *   empty: true  // All objects will be deleted when this resource is destroyed
 * });
 *
 * @see https://developers.cloudflare.com/r2/buckets/
 */
export const R2Bucket = Resource(
  "cloudflare::R2Bucket",
  async function (
    this: Context<R2Bucket>,
    id: string,
    props: BucketProps = {}
  ): Promise<R2Bucket> {
    const api = await createCloudflareApi(props);
    const bucketName = props.name || this.id;

    if (this.phase === "delete") {
      console.log("Deleting R2 bucket:", bucketName);
      if (props.delete !== false) {
        if (props.empty) {
          console.log("Emptying R2 bucket:", bucketName);
          const r2Client = await createR2Client({
            ...props,
            accountId: api.accountId,
          });
          // Empty the bucket first by deleting all objects
          await emptyBucket(r2Client, bucketName, props.jurisdiction);
        }

        // Delete R2 bucket
        console.log("Deleting R2 bucket:", bucketName);
        await deleteBucket(api, bucketName, props);
      }

      // Return void (a deleted bucket has no content)
      return this.destroy();
    } else {
      if (this.phase === "create") {
        console.log("Creating R2 bucket:", bucketName);
        await createBucket(api, bucketName, props);
      }

      await updatePublicAccess(
        api,
        bucketName,
        props.allowPublicAccess === true,
        props.jurisdiction
      );

      return this({
        name: bucketName,
        location: props.locationHint || "default",
        creationDate: new Date(),
        jurisdiction: props.jurisdiction || "default",
        type: "r2_bucket",
        accountId: api.accountId,
      });
    }
  }
);

/**
 * Configuration for R2 client to connect to Cloudflare R2
 */
export interface R2ClientConfig {
  accountId: string;
  accessKeyId?: Secret;
  secretAccessKey?: Secret;
  jurisdiction?: string;
}

type R2Client = AwsClient & { accountId: string };

/**
 * Creates an aws4fetch client configured for Cloudflare R2
 *
 * @see https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
 */
export function createR2Client(config?: R2ClientConfig): Promise<R2Client> {
  const accountId = config?.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId =
    config?.accessKeyId?.unencrypted || process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey =
    config?.secretAccessKey?.unencrypted || process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID environment variable is required");
  }

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY environment variables are required"
    );
  }

  // Create aws4fetch client with Cloudflare R2 endpoint
  const client: any = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
  });
  client.accountId = accountId;
  return client;
}

interface CloudflareBucketResponse {
  result: {
    name: string;
    location?: string;
    creation_date: string;
  };
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
}

/**
 * Adds jurisdiction header to the headers object if specified in props
 *
 * @param headers Headers object to modify
 * @param props Props or jurisdiction string
 * @returns Modified headers object
 */
export function withJurisdiction(
  headers: Record<string, string> = {},
  props: BucketProps | { jurisdiction?: string } | string | undefined
): Record<string, string> {
  // Clone the headers object to avoid modifying the original
  const result = { ...headers };

  let jurisdiction: string | undefined;
  if (typeof props === "string") {
    jurisdiction = props;
  } else if (props && "jurisdiction" in props) {
    jurisdiction = props.jurisdiction;
  }

  if (jurisdiction && jurisdiction !== "default") {
    result["cf-r2-jurisdiction"] = jurisdiction;
  }

  return result;
}

/**
 * Create a new bucket
 */
export async function createBucket(
  api: CloudflareApi,
  bucketName: string,
  props: BucketProps
): Promise<CloudflareBucketResponse> {
  // Create new R2 bucket
  const createPayload: any = {
    name: bucketName,
  };

  if (props.locationHint) {
    createPayload.location_hint = props.locationHint;
  }

  const headers = withJurisdiction({}, props);

  const createResponse = await api.post(
    `/accounts/${api.accountId}/r2/buckets`,
    createPayload,
    { headers }
  );

  if (!createResponse.ok) {
    return await handleApiError(
      createResponse,
      "creating",
      "R2 bucket",
      bucketName
    );
  }

  return (await createResponse.json()) as CloudflareBucketResponse;
}

/**
 * Delete a bucket
 */
export async function deleteBucket(
  api: CloudflareApi,
  bucketName: string,
  props: BucketProps
): Promise<void> {
  // Delete R2 bucket
  const headers = withJurisdiction({}, props);

  const deleteResponse = await api.delete(
    `/accounts/${api.accountId}/r2/buckets/${bucketName}`,
    { headers }
  );

  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    const errorData: any = await deleteResponse.json().catch(() => ({
      errors: [{ message: deleteResponse.statusText }],
    }));
    throw new CloudflareApiError(
      `Error deleting R2 bucket '${bucketName}': ${errorData.errors?.[0]?.message || deleteResponse.statusText}`,
      deleteResponse
    );
  }
}

/**
 * List objects in an R2 bucket
 *
 * @param r2 R2Client instance
 * @param bucketName Name of the bucket
 * @param continuationToken Optional token for pagination
 * @param jurisdiction Optional jurisdiction for the bucket
 * @returns Object containing the list of objects and the next continuation token
 */
export async function listObjects(
  r2: R2Client,
  bucketName: string,
  continuationToken?: string,
  jurisdiction?: string
): Promise<{ objects: { Key: string }[]; continuationToken?: string }> {
  // List objects in the bucket
  const url = new URL(
    `https://${r2.accountId}.r2.cloudflarestorage.com/${bucketName}`
  );
  if (continuationToken) {
    url.searchParams.set("continuation-token", continuationToken);
  }
  url.searchParams.set("list-type", "2");

  const headers = withJurisdiction({}, jurisdiction);

  const listResponse = await r2.fetch(url.toString(), { headers });
  if (!listResponse.ok) {
    throw new CloudflareApiError(
      `Failed to list objects: ${listResponse.statusText}`,
      listResponse
    );
  }

  const responseText = await listResponse.text();

  // Extract objects from XML response using regex
  const keyRegex = /<Key>([^<]+)<\/Key>/g;
  const objects: { Key: string }[] = [];
  let match;
  while ((match = keyRegex.exec(responseText)) !== null) {
    objects.push({ Key: match[1] });
  }

  // Get continuation token if present using regex
  const tokenMatch =
    /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(
      responseText
    );
  const nextContinuationToken = tokenMatch ? tokenMatch[1] : undefined;

  return { objects, continuationToken: nextContinuationToken };
}

/**
 * Helper function to empty a bucket by deleting all objects
 */
export async function emptyBucket(
  r2: R2Client,
  bucketName: string,
  jurisdiction?: string
): Promise<void> {
  let continuationToken: string | undefined;
  let totalDeleted = 0;

  try {
    do {
      console.log(`Listing objects in bucket ${bucketName}`);
      // List objects in the bucket
      const { objects, continuationToken: nextToken } = await listObjects(
        r2,
        bucketName,
        continuationToken,
        jurisdiction
      );

      continuationToken = nextToken;

      console.log(`Found ${objects.length} objects in bucket ${bucketName}`);

      // Delete objects in batches
      if (objects.length > 0) {
        // Process delete in batches of 1000 (S3 limit)
        for (let i = 0; i < objects.length; i += 1000) {
          const batch = objects.slice(i, i + 1000);

          // Create DeleteObjects request XML
          const deleteXml = `
            <Delete>
              ${batch.map((obj) => `<Object><Key>${obj.Key}</Key></Object>`).join("")}
            </Delete>
          `;

          const deleteUrl = new URL(
            `https://${r2.accountId}.r2.cloudflarestorage.com/${bucketName}?delete`
          );

          console.log(
            `Deleting ${batch.length} objects from bucket ${bucketName}`
          );

          const headers = withJurisdiction(
            { "Content-Type": "application/xml" },
            jurisdiction
          );

          const deleteResponse = await r2.fetch(deleteUrl.toString(), {
            method: "POST",
            body: deleteXml,
            headers,
          });

          if (!deleteResponse.ok) {
            throw new CloudflareApiError(
              `Failed to delete objects: ${deleteResponse.statusText}`,
              deleteResponse
            );
          }

          totalDeleted += batch.length;
        }
      }
    } while (continuationToken);

    console.log(
      `Successfully emptied bucket ${bucketName}, deleted ${totalDeleted} objects total`
    );
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      // the bucket was not found
      return;
    }
    console.error(`Failed to empty bucket ${bucketName}:`, error);
    throw error;
  }
}

/**
 * Update public access setting for a bucket
 *
 * This operation is not available through the S3 API for R2,
 * so we still use the Cloudflare API directly.
 */
export async function updatePublicAccess(
  api: CloudflareApi,
  bucketName: string,
  allowPublicAccess: boolean,
  jurisdiction?: string
): Promise<void> {
  const headers = withJurisdiction({}, jurisdiction);

  const response = await api.put(
    `/accounts/${api.accountId}/r2/buckets/${bucketName}/domains/managed`,
    {
      enabled: allowPublicAccess,
    },
    { headers }
  );

  if (!response.ok) {
    await handleApiError(
      response,
      "updating public access for",
      "R2 bucket",
      bucketName
    );
  }
}

/**
 * Set CORS configuration for a bucket using aws4fetch
 */
export async function setCorsConfiguration(
  r2: R2Client,
  bucketName: string,
  allowedOrigins: string[] = ["*"],
  allowedMethods: string[] = ["GET", "HEAD", "PUT", "POST", "DELETE"],
  allowedHeaders: string[] = ["*"],
  maxAgeSeconds: number = 3600,
  jurisdiction?: string
): Promise<void> {
  try {
    // Construct CORS XML configuration
    const corsXml = `
      <CORSConfiguration>
        <CORSRule>
          ${allowedOrigins.map((origin) => `<AllowedOrigin>${origin}</AllowedOrigin>`).join("")}
          ${allowedMethods.map((method) => `<AllowedMethod>${method}</AllowedMethod>`).join("")}
          ${allowedHeaders.map((header) => `<AllowedHeader>${header}</AllowedHeader>`).join("")}
          <ExposeHeader>ETag</ExposeHeader>
          <MaxAgeSeconds>${maxAgeSeconds}</MaxAgeSeconds>
        </CORSRule>
      </CORSConfiguration>
    `;

    const url = new URL(
      `https://${r2.accountId}.r2.cloudflarestorage.com/${bucketName}?cors`
    );

    const headers = withJurisdiction(
      { "Content-Type": "application/xml" },
      jurisdiction
    );

    const response = await r2.fetch(url.toString(), {
      method: "PUT",
      body: corsXml,
      headers,
    });

    if (!response.ok) {
      throw new CloudflareApiError(
        `Failed to set CORS configuration: ${response.statusText}`,
        response
      );
    }

    console.log(`Successfully set CORS configuration for bucket ${bucketName}`);
  } catch (error) {
    console.error(
      `Failed to set CORS configuration for bucket ${bucketName}:`,
      error
    );
    throw error;
  }
}

/**
 * Information about an R2 bucket returned by list operations
 */
export interface R2BucketInfo {
  /**
   * Name of the bucket
   */
  Name: string;

  /**
   * Creation date of the bucket
   */
  CreationDate: Date;
}

/**
 * List all R2 buckets in an account
 *
 * @param api CloudflareApi instance
 * @param options Optional listing options
 * @returns Array of bucket information
 */
export async function listBuckets(
  api: CloudflareApi,
  options: {
    nameContains?: string;
    perPage?: number;
    cursor?: string;
    direction?: "asc" | "desc";
    jurisdiction?: string;
  } = {}
): Promise<R2BucketInfo[]> {
  // Build query parameters
  const params = new URLSearchParams();

  if (options.nameContains) {
    params.append("name_contains", options.nameContains);
  }

  if (options.perPage) {
    params.append("per_page", options.perPage.toString());
  }

  if (options.cursor) {
    params.append("cursor", options.cursor);
  }

  if (options.direction) {
    params.append("direction", options.direction);
  }

  // Build URL with query parameters
  const path = `/accounts/${api.accountId}/r2/buckets${params.toString() ? "?" + params.toString() : ""}`;

  // Set jurisdiction header if provided
  const headers = withJurisdiction({}, options.jurisdiction);

  // Make the API request
  const response = await api.get(path, { headers });

  if (!response.ok) {
    throw new CloudflareApiError(
      `Failed to list buckets: ${response.statusText}`,
      response
    );
  }

  const data = (await response.json()) as {
    success: boolean;
    errors?: Array<{ code: number; message: string }>;
    result?: {
      buckets: Array<{
        name: string;
        creation_date: string;
        location?: string;
      }>;
    };
  };

  if (!data.success) {
    const errorMessage = data.errors?.[0]?.message || "Unknown error";
    throw new Error(`Failed to list buckets: ${errorMessage}`);
  }

  // Transform API response to R2BucketInfo objects
  return (data.result?.buckets || []).map((bucket) => ({
    Name: bucket.name,
    CreationDate: new Date(bucket.creation_date),
  }));
}
