import { Resource } from "../resource.ts";
import { extractCloudflareResult } from "./api-response.ts";
import { createCloudflareApi, type CloudflareApiOptions } from "./api.ts";

/**
 * Cloudflare permission group as returned by the API
 */
export interface PermissionGroup {
  /**
   * Unique identifier for the permission group
   */
  id: string;

  /**
   * Human-readable name of the permission group
   */
  name: string;

  /**
   * Scopes included in this permission group
   */
  scopes: string[];
}

export type PermissionGroupName = R2PermissionGroups | (string & {});

export type R2PermissionGroups =
  | "Workers R2 Storage Write"
  | "Workers R2 Storage Read"
  | "Workers R2 Storage Bucket Item Write"
  | "Workers R2 Storage Bucket Item Read";

/**
 * All Cloudflare permission groups mapped by name to ID
 *
 * @see https://developers.cloudflare.com/r2/api/tokens/#permissions
 */
export type PermissionGroups = {
  /**
   * Admin Read & Write - Allows create, list, delete buckets and edit bucket configurations
   * plus list, write, and read object access
   */
  "Workers R2 Storage Write": PermissionGroup;

  /**
   * Admin Read only - Allows list buckets and view bucket configuration
   * plus list and read object access
   */
  "Workers R2 Storage Read": PermissionGroup;

  /**
   * Object Read & Write - Allows read, write, and list objects in specific buckets
   */
  "Workers R2 Storage Bucket Item Write": PermissionGroup;

  /**
   * Object Read only - Allows read and list objects in specific buckets
   */
  "Workers R2 Storage Bucket Item Read": PermissionGroup;

  /**
   * Dynamically discovered permission groups
   */
  [name: string]: PermissionGroup;
};

/**
 * Lists all permission groups available for the Cloudflare account
 * and returns a typed map of permission names to their IDs.
 *
 * This is primarily used when creating API tokens for Cloudflare services like R2.
 *
 * Note: Requires a Cloudflare API Key or Token with account read access.
 * The API token must have permission to read token permission groups.
 * The OAuth token from `wrangler login` is NOT sufficient for this operation.
 *
 * @example
 * // Get all permission groups including those for R2
 * const permissions = await PermissionGroups();
 *
 * // Use with AccountApiToken to create a token with proper permissions
 * const token = await AccountApiToken("r2-token", {
 *   name: "R2 Read-Only Token",
 *   policies: [
 *     {
 *       effect: "allow",
 *       resources: {
 *         "com.cloudflare.edge.r2.bucket.abc123_default_my-bucket": "*"
 *       },
 *       permissionGroups: [
 *         {
 *           id: permissions["Workers R2 Storage Bucket Item Read"]
 *         }
 *       ]
 *     }
 *   ]
 * });
 */
export async function PermissionGroups(
  options: CloudflareApiOptions = {},
): Promise<PermissionGroups> {
  const api = await createCloudflareApi(options);
  const result = await extractCloudflareResult<PermissionGroup[]>(
    "fetch permission groups",
    api.get(`/accounts/${api.accountId}/tokens/permission_groups`),
  );
  return Object.fromEntries(
    result.map((group) => [group.name, group]),
  ) as PermissionGroups;
}

// we are deprecating the PermissionGroups resource (it is now just a function)
Resource("cloudflare::PermissionGroups", async function (this) {
  if (this.phase === "delete") {
    return this.destroy();
  }

  throw new Error("Not implemented");
});
