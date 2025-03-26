import type { Context } from "../context";
import { Resource } from "../resource";
import { createCloudflareApi } from "./api";

/**
 * Properties for creating or updating an R2 Bucket
 */
export interface BucketProps {
  /**
   * Name of the bucket
   * Names can only contain lowercase letters (a-z), numbers (0-9), and hyphens (-)
   * Cannot begin or end with a hyphen
   */
  name: string;

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
   * Location of the bucket
   */
  location: string;

  /**
   * Time at which the bucket was created (Unix timestamp in seconds)
   */
  creationDate: number;
}

export const R2Bucket = Resource(
  "cloudflare::R2Bucket",
  async function (
    this: Context<R2Bucket>,
    id: string,
    props: BucketProps,
  ): Promise<R2Bucket> {
    // Create Cloudflare API client with automatic account discovery
    const api = await createCloudflareApi();

    // Resource ID defaults to bucket name if provided
    const bucketName = props.name || this.id;

    if (this.phase === "delete") {
      if (this.output?.name) {
        // Delete R2 bucket
        const headers: Record<string, string> = {};
        if (props.jurisdiction && props.jurisdiction !== "default") {
          headers["cf-r2-jurisdiction"] = props.jurisdiction;
        }

        const deleteResponse = await api.delete(
          `/accounts/${api.accountId}/r2/buckets/${this.output.name}`,
          { headers },
        );

        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          const errorData: any = await deleteResponse.json().catch(() => ({
            errors: [{ message: deleteResponse.statusText }],
          }));
          throw new Error(
            `Error deleting R2 bucket '${bucketName}': ${errorData.errors?.[0]?.message || deleteResponse.statusText}`,
          );
        }
      }

      // Return void (a deleted bucket has no content)
      return this.destroy();
    } else {
      /**
       * Cloudflare R2 bucket API response
       */
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
      try {
        let bucketOutput: R2Bucket;

        if (this.phase === "update" && this.output?.name) {
          // Get bucket details to verify it exists
          const headers: Record<string, string> = {};
          if (props.jurisdiction && props.jurisdiction !== "default") {
            headers["cf-r2-jurisdiction"] = props.jurisdiction;
          }

          const getResponse = await api.get(
            `/accounts/${api.accountId}/r2/buckets/${bucketName}`,
            { headers },
          );

          if (!getResponse.ok) {
            const errorData: any = await getResponse.json().catch(() => ({
              errors: [{ message: getResponse.statusText }],
            }));
            throw new Error(
              `Error getting R2 bucket '${bucketName}': ${errorData.errors?.[0]?.message || getResponse.statusText}`,
            );
          }

          const result = (await getResponse.json()) as CloudflareBucketResponse;
          bucketOutput = this({
            name: result.result.name,
            location: result.result.location || "default",
            creationDate: Math.floor(
              new Date(result.result.creation_date).getTime() / 1000,
            ),
            jurisdiction: props.jurisdiction || "default",
            type: "r2_bucket",
          });

          // Update public access setting if it has changed
          if (props.allowPublicAccess !== undefined) {
            await updatePublicAccess(api, bucketName, props.allowPublicAccess);
          }
        } else {
          // Create new R2 bucket
          const createPayload: any = {
            name: bucketName,
          };

          if (props.locationHint) {
            createPayload.location_hint = props.locationHint;
          }

          const headers: Record<string, string> = {};
          if (props.jurisdiction && props.jurisdiction !== "default") {
            headers["cf-r2-jurisdiction"] = props.jurisdiction;
          }

          const createResponse = await api.post(
            `/accounts/${api.accountId}/r2/buckets`,
            createPayload,
            { headers },
          );

          if (!createResponse.ok) {
            const errorData: any = await createResponse.json().catch(() => ({
              errors: [{ message: createResponse.statusText }],
            }));
            throw new Error(
              `Error creating R2 bucket '${bucketName}': ${errorData.errors?.[0]?.message || createResponse.statusText}`,
            );
          }

          const result =
            (await createResponse.json()) as CloudflareBucketResponse;
          bucketOutput = this({
            name: result.result.name,
            location: result.result.location || "default",
            creationDate: Math.floor(
              new Date(result.result.creation_date).getTime() / 1000,
            ),
            jurisdiction: props.jurisdiction || "default",
            type: "r2_bucket",
          });

          // Set public access if requested
          if (props.allowPublicAccess) {
            await updatePublicAccess(api, bucketName, true);
          }
        }

        return bucketOutput;
      } catch (error) {
        console.error("Error creating/updating R2 bucket:", error);
        throw error;
      }
    }
  },
);

/**
 * Helper function to update the public access setting for a bucket
 */
async function updatePublicAccess(
  api: any,
  bucketName: string,
  allowPublicAccess: boolean,
): Promise<void> {
  try {
    const response = await api.put(
      `/accounts/${api.accountId}/r2/buckets/${bucketName}/domains/managed`,
      {
        enabled: allowPublicAccess,
      },
    );

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({
        errors: [{ message: response.statusText }],
      }));
      throw new Error(
        `Error updating R2 bucket public access: ${errorData.errors?.[0]?.message || response.statusText}`,
      );
    }
  } catch (error) {
    console.warn("Could not set public access:", error);
  }
}
