import type { Context } from "../context";
import { Resource } from "../resource";
import { withExponentialBackoff } from "../util/retry";
import { createCloudflareApi } from "./api";

export function isKVNamespace(resource: any): resource is KVNamespace {
  return (
    resource && typeof resource === "object" && resource.type === "kv_namespace"
  );
}

/**
 * Properties for creating or updating a KV Namespace
 */
export interface KVNamespaceProps {
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

export const KVNamespace = Resource(
  "cloudflare::KVNamespace",
  async function (
    this: Context<KVNamespace>,
    id: string,
    props: KVNamespaceProps,
  ) {
    // Create Cloudflare API client with automatic account discovery
    const api = await createCloudflareApi();

    if (this.phase === "delete") {
      // For delete operations, we need to check if the namespace ID exists in the output
      const namespaceId = this.output?.namespaceId;
      if (namespaceId) {
        // Delete KV namespace
        const deleteResponse = await api.delete(
          `/accounts/${api.accountId}/storage/kv/namespaces/${namespaceId}`,
        );

        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          const errorData: any = await deleteResponse.json().catch(() => ({
            errors: [{ message: deleteResponse.statusText }],
          }));
          throw new Error(
            `Error deleting KV namespace '${props.title}': ${errorData.errors?.[0]?.message || deleteResponse.statusText}`,
          );
        }
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

        // Create new KV namespace
        const createResponse = await api.post(
          `/accounts/${api.accountId}/storage/kv/namespaces`,
          {
            title: props.title,
          },
        );

        if (!createResponse.ok) {
          const errorData: any = await createResponse.json().catch(() => ({
            errors: [{ message: createResponse.statusText }],
          }));
          throw new Error(
            `Error creating KV namespace '${props.title}': ${errorData.errors?.[0]?.message || createResponse.statusText}`,
          );
        }

        const createResult: any = await createResponse.json();
        namespaceId = createResult.result.id;
        createdAt = Date.now();
      }

      // Handle KV pairs if provided
      if (props.values && props.values.length > 0 && namespaceId) {
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
                  bulkPayload,
                );

                if (!bulkResponse.ok) {
                  const errorData: any = await bulkResponse
                    .json()
                    .catch(() => ({
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
              1000, // Start with 1 second delay
            );
          } catch (error: any) {
            console.warn(error.message);
          }
        }
      }

      return this({
        type: "kv_namespace",
        namespaceId: namespaceId,
        title: props.title,
        values: props.values,
        createdAt: createdAt,
        modifiedAt: Date.now(),
      });
    }
  },
);
