import type { Context } from "../context.js";
import { Resource } from "../resource.js";
import { withExponentialBackoff } from "../util/retry.js";
import { handleApiError } from "./api-error.js";
import {
  CloudflareApi,
  createCloudflareApi,
  type CloudflareApiOptions,
} from "./api.js";

/**
 * Properties for creating or updating a KV Namespace
 */
export interface KVNamespaceProps extends CloudflareApiOptions {
  /**
   * Title of the namespace
   */
  title: string;

  /**
   * KV pairs to store in the namespace
   * Only used for initial setup or updates
   */
  values?: KVPair[];
}

/**
 * Key-value pair to store in a KV Namespace
 */
export interface KVPair {
  /**
   * Key name
   */
  key: string;

  /**
   * Value to store (string or JSON object)
   */
  value: string | object;

  /**
   * Optional expiration in seconds from now
   */
  expiration?: number;

  /**
   * Optional expiration timestamp in seconds since epoch
   */
  expirationTtl?: number;

  /**
   * Optional metadata for the key
   */
  metadata?: any;
}

/**
 * Output returned after KV Namespace creation/update
 */
export interface KVNamespace
  extends Resource<"cloudflare::KVNamespace">,
    KVNamespaceProps {
  type: "kv_namespace";
  /**
   * The ID of the namespace
   */
  namespaceId: string;

  /**
   * Time at which the namespace was created
   */
  createdAt: number;

  /**
   * Time at which the namespace was last modified
   */
  modifiedAt: number;
}

/**
 * A Cloudflare KV Namespace is a key-value store that can be used to store data for your application.
 *
 * @see https://developers.cloudflare.com/kv/concepts/kv-namespaces/
 *
 * @example
 * // Create a basic KV namespace for storing user data
 * const users = await KVNamespace("users", {
 *   title: "user-data"
 * });
 *
 * @example
 * // Create a KV namespace with initial values and TTL
 * const sessions = await KVNamespace("sessions", {
 *   title: "user-sessions",
 *   values: [{
 *     key: "session_123",
 *     value: { userId: "user_456", role: "admin" },
 *     expirationTtl: 3600 // Expires in 1 hour
 *   }]
 * });
 *
 * @example
 * // Create a KV namespace with metadata for caching
 * const assets = await KVNamespace("assets", {
 *   title: "static-assets",
 *   values: [{
 *     key: "main.js",
 *     value: "content...",
 *     metadata: {
 *       contentType: "application/javascript",
 *       etag: "abc123"
 *     }
 *   }]
 * });
 */
export const KVNamespace = Resource(
  "cloudflare::KVNamespace",
  async function (
    this: Context<KVNamespace>,
    id: string,
    props: KVNamespaceProps
  ) {
    // Create Cloudflare API client with automatic account discovery
    const api = await createCloudflareApi(props);

    if (this.phase === "delete") {
      // For delete operations, we need to check if the namespace ID exists in the output
      const namespaceId = this.output?.namespaceId;
      if (namespaceId) {
        await deleteKVNamespace(api, namespaceId);
      }

      // Return minimal output for deleted state
      return this.destroy();
    } else {
      // For create or update operations
      // If this.phase is "update", we expect this.output to exist
      let namespaceId =
        this.phase === "update" ? this.output?.namespaceId || "" : "";
      let createdAt =
        this.phase === "update"
          ? this.output?.createdAt || Date.now()
          : Date.now();

      if (this.phase === "update" && namespaceId) {
        // Can't update a KV namespace title directly, just work with existing ID
      } else {
        // TODO: if it already exists, then check the tags to see if we own it and continue
        const { id } = await createKVNamespace(api, props);
        createdAt = Date.now();
        namespaceId = id;
      }

      await insertKVRecords(api, namespaceId, props);

      return this({
        type: "kv_namespace",
        namespaceId: namespaceId,
        title: props.title,
        values: props.values,
        createdAt: createdAt,
        modifiedAt: Date.now(),
      });
    }
  }
);

export async function createKVNamespace(
  api: CloudflareApi,
  props: KVNamespaceProps
): Promise<{ id: string }> {
  const createResponse = await api.post(
    `/accounts/${api.accountId}/storage/kv/namespaces`,
    {
      title: props.title,
    }
  );

  if (!createResponse.ok) {
    await handleApiError(createResponse, "create", "kv_namespace", props.title);
  }

  return { id: ((await createResponse.json()) as any).result.id };
}

export async function deleteKVNamespace(
  api: CloudflareApi,
  namespaceId: string
) {
  // Delete KV namespace
  const deleteResponse = await api.delete(
    `/accounts/${api.accountId}/storage/kv/namespaces/${namespaceId}`
  );

  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    await handleApiError(deleteResponse, "delete", "kv_namespace", namespaceId);
  }
}

export async function insertKVRecords(
  api: CloudflareApi,
  namespaceId: string,
  props: KVNamespaceProps
) {
  if (props.values && props.values.length > 0) {
    // Process KV pairs in batches of 10000 (API limit)
    const BATCH_SIZE = 10000;

    for (let i = 0; i < props.values.length; i += BATCH_SIZE) {
      const batch = props.values.slice(i, i + BATCH_SIZE);

      const bulkPayload = batch.map((entry) => {
        const item: any = {
          key: entry.key,
          value:
            typeof entry.value === "string"
              ? entry.value
              : JSON.stringify(entry.value),
        };

        if (entry.expiration) {
          item.expiration = entry.expiration;
        }

        if (entry.expirationTtl) {
          item.expiration_ttl = entry.expirationTtl;
        }

        if (entry.metadata) {
          item.metadata = entry.metadata;
        }

        return item;
      });

      try {
        await withExponentialBackoff(
          async () => {
            const bulkResponse = await api.put(
              `/accounts/${api.accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
              bulkPayload
            );

            if (!bulkResponse.ok) {
              const errorData: any = await bulkResponse.json().catch(() => ({
                errors: [{ message: bulkResponse.statusText }],
              }));
              const errorMessage =
                errorData.errors?.[0]?.message || bulkResponse.statusText;

              // Throw error to trigger retry
              throw new Error(`Error writing KV batch: ${errorMessage}`);
            }

            return bulkResponse;
          },
          (error) => {
            // Retry on "namespace not found" errors as they're likely propagation delays
            return error.message?.includes("not found");
          },
          5, // 5 retry attempts
          1000 // Start with 1 second delay
        );
      } catch (error: any) {
        console.warn(error.message);
      }
    }
  }
}
