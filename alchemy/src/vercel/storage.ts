import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import type { Secret } from "../secret.ts";
import { createVercelApi, VercelApi } from "./api";

type StorageType = "blob";

/**
 * Properties for creating or updating a Storage
 */
export interface StorageProps {
  /**
   * The desired name for the storage
   */
  name: string;

  /**
   * The region where the storage will be deployed
   */
  region: string;

  /**
   * The team ID that the storage belongs to
   */
  teamId: string;

  /**
   * The type of storage
   */
  type: StorageType;
}

/**
 * Output returned after Storage creation/update
 */
export interface Storage extends Resource<"vercel::Storage">, StorageProps {
  /**
   * The ID of the storage
   */
  id: string;

  /**
   * The storage store information
   */
  store: {
    /**
     * The billing state of the storage
     */
    billingState: string;

    /**
     * The count of items in the storage
     */
    count: number;

    /**
     * The time at which the storage was created
     */
    createdAt: number;

    /**
     * The ID of the store
     */
    id: string;

    /**
     * The name of the store
     */
    name: string;

    /**
     * The ID of the owner
     */
    ownerId: string;

    /**
     * The projects metadata
     */
    projectsMetadata: {}[];

    /**
     * The region where the storage is deployed
     */
    region: string;

    /**
     * The size of the storage
     */
    size: number;

    /**
     * The status of the storage
     */
    status: string;

    /**
     * The type of storage
     */
    type: StorageType;

    /**
     * The time at which the storage was last updated
     */
    updatedAt: number;

    /**
     * Whether the usage quota has been exceeded
     */
    usageQuotaExceeded: boolean;
  },
}

/**
 * Create and manage Vercel storage.
 *
 * @example
 * // With accessToken
 * const storage = await Storage("my-storage", {
 *   accessToken: alchemy.secret(process.env.VERCEL_ACCESS_TOKEN),
 *   name: "my-storage",
 *   region: "iad1",
 *   teamId: "team_123",
 *   type: "blob",
 * });
 *
 * @example
 * // Basic storage creation
 * const storage = await Storage("my-storage", {
 *   name: "my-storage",
 *   region: "iad1",
 *   teamId: "team_123",
 *   type: "blob",
 * });
 */
export const Storage = Resource(
  "vercel::Storage",
  async function (
    this: Context<Storage>,
    id: string,
    { accessToken, ...props }: StorageProps & { accessToken?: Secret },
  ): Promise<Storage> {
    const api = await createVercelApi({
      baseUrl: "https://api.vercel.com/v1",
      accessToken,
    });
    switch (this.phase) {
      case "create": {
        const storage = await createStorage(api, props);
        return this({ ...props, ...storage, id: storage.store.id });
      }

      case "update": {
        if (props.name !== this.output.name) {
          return this.replace()
        }
        return this({ ...props, ...this.output });
      }

      case "delete": {
        await deleteStorage(api, this.output);
        return this.destroy();
      }
    }
  },
);

/**
 * Create a new storage instance
 */
async function createStorage(api: VercelApi, props: StorageProps) {
  const response = await api.post(`/storage/stores/${props.type}?teamId=${props.teamId}`, {
    name: props.name,
    region: props.region,
  });
  return response.json() as Promise<{ store: Storage["store"] }>;
}

/**
 * Delete a storage instance
 */
async function deleteStorage(api: VercelApi, output: Storage) {
  await api.delete(`/storage/stores/${output.id}/connections?teamId=${output.teamId}`);
  await api.delete(`/storage/stores/${output.type}/${output.id}?teamId=${output.teamId}`);
}