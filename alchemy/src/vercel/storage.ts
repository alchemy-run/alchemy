import { fromPromise } from 'neverthrow';
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import type { Secret } from "../secret.ts";
import { createVercelApi, VercelApi } from "./api";

type StorageType = "blob";

interface StorageProject {
  projectId: string;
  envVarEnvironments: ["production" | "preview" | "development"];
  envVarPrefix?: string;
}

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

  /**
   * The projects that the storage belongs to
   */
  projects: StorageProject[];
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
    projectsMetadata: {
      environments: StorageProject["envVarEnvironments"];
      environmentVariables: string[];
      envVarPrefix: StorageProject["envVarPrefix"];
      framework: string;
      id: string;
      name: string;
      projectId: string;
    }[];

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

        const output = { ...props, ...storage, id: storage.store.id } as Storage;

        if (props.projects.length > 0) {
          await createProjectsConnection(api, output, props.projects);
          const updatedStorage = await readStorage(api, output);
          output.store = updatedStorage.store;
        }

        return this(output);
      }

      case "update": {
        if (props.name !== this.output.name) {
          return this.replace()
        }

        const projectsMetadata = this.output.store.projectsMetadata ?? [];
        const projects = props.projects ?? [];

        const currentProjectIds = new Set(
          projectsMetadata.map((p) => p.projectId)
        );
        
        const newProjectIds = new Set(
          projects.map((p) => p.projectId)
        );

        const toDelete = projectsMetadata
          .filter((p) => !newProjectIds.has(p.projectId))

        if (toDelete.length > 0) {
          await deleteProjectsConnection(api, this.output, toDelete);
        }

        const toCreate = projects
          .filter((project) => !currentProjectIds.has(project.projectId));

        if (toCreate.length > 0) {
          await createProjectsConnection(api, this.output, toCreate);
        }

        if (toDelete.length > 0 || toCreate.length > 0) {
          const updatedStorage = await readStorage(api, this.output);
          this.output.store = updatedStorage.store;
        }

        return this({ ...this.output, ...props });
      }

      case "delete": {
        await deleteStorage(api, this.output);
        return this.destroy();
      }
    }
  },
);

async function readStorage(api: VercelApi, output: Storage) {
  const response = await fromPromise(api.get(`/storage/stores/${output.id}?teamId=${output.teamId}`), (err) => err as Error);

  if (response.isErr()) {
    throw response.error;
  }

  return response.value.json() as Promise<{ store: Storage["store"] }>;
}

/**
 * Create a new storage instance
 */
async function createStorage(api: VercelApi, props: StorageProps) {
  const response = await fromPromise(api.post(`/storage/stores/${props.type}?teamId=${props.teamId}`, {
    name: props.name,
    region: props.region,
  }), (err) => err as Error);

  if (response.isErr()) {
    throw response.error;
  }

  return response.value.json() as Promise<{ store: Storage["store"] }>;
}

/**
 * Delete a storage instance
 */
async function deleteStorage(api: VercelApi, output: Storage) {
  const connections = await fromPromise(api.delete(`/storage/stores/${output.id}/connections?teamId=${output.teamId}`), (err) => err as Error);

  if (connections.isErr()) {  
    throw connections.error;
  }

  const storage = await fromPromise(api.delete(`/storage/stores/${output.type}/${output.id}?teamId=${output.teamId}`), (err) => err as Error);

  if (storage.isErr()) {
    throw storage.error;
  }
}

async function createProjectsConnection(api: VercelApi, output: Storage, projects: StorageProject[]) {
  // Promise.all didn't worked well with the API, so we're using a for loop instead
  for (const project of projects) {
    await connectProject(api, output, project);
  }
}

async function deleteProjectsConnection(api: VercelApi, output: Storage, projectsMetadata: Storage["store"]["projectsMetadata"]) {
  // Promise.all didn't worked well with the API, so we're using a for loop instead
  for (const metadata of projectsMetadata) {
    await disconnectProject(api, output, metadata);
  }
}

async function connectProject(api: VercelApi, output: Storage, project: StorageProject) {
  const response = await fromPromise(api.post(`/storage/stores/${output.id}/connections?teamId=${output.teamId}`, {
    envVarEnvironments: project.envVarEnvironments,
    envVarPrefix: project.envVarPrefix,
    projectId: project.projectId,
  }), (err) => err as Error);

  if (response.isErr()) {
    throw response.error;
  }
}

async function disconnectProject(api: VercelApi, output: Storage, metadata: Storage["store"]["projectsMetadata"][number]) {
  const response = await fromPromise(api.delete(`/storage/stores/${output.id}/connections/${metadata.id}?teamId=${output.teamId}`), (err) => err as Error);

  if (response.isErr()) {
    throw response.error;
  }
}