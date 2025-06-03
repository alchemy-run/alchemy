import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";

export type PlanetScaleClusterSize =
  | "PS_DEV"
  | "PS_10"
  | "PS_20"
  | "PS_40"
  | "PS_80"
  | "PS_160"
  | "PS_320"
  | "PS_400"
  | "PS_640"
  | "PS_700"
  | "PS_900"
  | "PS_1280"
  | "PS_1400"
  | "PS_1800"
  | "PS_2100"
  | "PS_2560"
  | "PS_2700"
  | "PS_2800"
  | (string & {});
/**
 * Wait for a database to be ready with exponential backoff
 */
export async function waitForDatabaseReady(
  api: PlanetScaleApi,
  organizationId: string,
  databaseName: string,
  branchName?: string,
): Promise<void> {
  const startTime = Date.now();
  let waitMs = 100;
  const branchSuffix = branchName ? `/branches/${branchName}` : "";
  while (true) {
    const response = await api.get(
      `/organizations/${organizationId}/databases/${databaseName}${branchSuffix}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to check database state: ${response.statusText}`);
    }

    const data = await response.json<any>();
    if (data.ready === true) {
      return;
    }

    if (Date.now() - startTime >= 60000) {
      throw new Error(
        `Timeout waiting for database ${databaseName} to be ready`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, waitMs));
    waitMs = Math.min(waitMs * 2, 1000); // Cap at 1s intervals
  }
}

const waitForKeyspaceReady = async (
  api: PlanetScaleApi,
  org: string,
  db: string,
  branch: string,
  keyspace: string,
): Promise<void> => {
  const start = Date.now();
  let delay = 100;

  while (true) {
    const res = await api.get(
      `/organizations/${org}/databases/${db}/branches/${branch}/keyspaces/${keyspace}/resizes`,
    );
    if (!res.ok) {
      throw new Error(
        `Error fetching keyspace "${keyspace}": ${res.statusText}`,
      );
    }

    const ks = await res.json<{
      data: [
        {
          state: string;
        },
      ];
    }>();
    // once it's fully ready, we can proceed
    if (ks.data.every((item) => item.state !== "resizing")) {
      return;
    }

    if (Date.now() - start > 600_000) {
      throw new Error(`Timeout waiting for keyspace "${keyspace}" to be ready`);
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 1_000);
  }
};

export const fixClusterSize = async (
  api: PlanetScaleApi,
  organizationId: string,
  databaseName: string,
  branchName: string,
  expectedClusterSize: PlanetScaleClusterSize,
  isDBReady: boolean,
) => {
  if (!isDBReady) {
    await waitForDatabaseReady(api, organizationId, databaseName);
  }

  // 1. Ensure branch is production
  let branchRes = await api.get(
    `/organizations/${organizationId}/databases/${databaseName}/branches/${branchName}`,
  );
  if (!branchRes.ok) {
    throw new Error(`Unable to get branch data: ${branchRes.statusText}`);
  }
  let branchData = await branchRes.json<any>();
  if (!branchData.production) {
    if (!branchData.ready) {
      await waitForDatabaseReady(api, organizationId, databaseName, branchName);
    }
    const promoteRes = await api.post(
      `/organizations/${organizationId}/databases/${databaseName}/branches/${branchName}/promote`,
    );
    if (!promoteRes.ok) {
      throw new Error(`Unable to promote branch: ${promoteRes.statusText}`);
    }
  }
  // 2. Load default keyspace
  const ksListRes = await api.get(
    `/organizations/${organizationId}/databases/${databaseName}/branches/${branchName}/keyspaces`,
  );
  if (!ksListRes.ok) {
    throw new Error(`Failed to list keyspaces: ${ksListRes.statusText}`);
  }
  const ksList = (await ksListRes.json<any>()).data as Array<{
    name: string;
    cluster_name: string;
  }>;
  const defaultKsData = ksList.find((x) => x.name === databaseName); // Default keypsace is always the same name as the database
  if (ksList.length === 0 || !defaultKsData) {
    throw new Error(`No default keyspace found for branch ${branchName}`);
  }
  const defaultKs = defaultKsData.name;
  let currentSize = defaultKsData.cluster_name as PlanetScaleClusterSize;

  // 3. Wait until any in-flight resize is done
  await waitForKeyspaceReady(
    api,
    organizationId,
    databaseName,
    branchName,
    defaultKs,
  );

  // 4. If size mismatch, trigger resize and wait again
  // Ideally this would use the undocumented Keyspaces API, but there seems to be a missing oauth scope that we cannot add via the console yet
  if (currentSize !== expectedClusterSize) {
    const resizeRes = await api.patch(
      `/organizations/${organizationId}/databases/${databaseName}/branches/${branchName}/cluster`,
      { cluster_size: expectedClusterSize },
    );
    if (!resizeRes.ok) {
      const text = await resizeRes.text();
      throw new Error(
        `Failed to start resize: ${resizeRes.statusText} ${text}`,
      );
    }

    // Poll until the resize completes
    await waitForKeyspaceReady(
      api,
      organizationId,
      databaseName,
      branchName,
      defaultKs,
    );
  }
};

/**
 * Properties for creating or updating a PlanetScale Database
 */
export interface DatabaseProps {
  /**
   * The name of the database
   */
  name: string;

  /**
   * The organization ID where the database will be created
   */
  organizationId: string;

  /**
   * Whether to adopt the database if it already exists in Planetscale
   */
  adopt?: boolean;

  /**
   * The region where the database will be created (create only)
   */
  region?: {
    /**
     * The slug identifier of the region
     */
    slug: string;
  };

  /**
   * Whether to require approval for deployments
   */
  requireApprovalForDeploy?: boolean;

  /**
   * Whether to allow data branching
   */
  allowDataBranching?: boolean;

  /**
   * Whether to enable automatic migrations
   */
  automaticMigrations?: boolean;

  /**
   * Whether to restrict branch creation to the same region as database
   */
  restrictBranchRegion?: boolean;

  /**
   * Whether to collect full queries from the database
   */
  insightsRawQueries?: boolean;

  /**
   * Whether web console can be used on production branch
   */
  productionBranchWebConsole?: boolean;

  /**
   * The default branch of the database
   */
  defaultBranch?: string;

  /**
   * Migration framework to use on the database
   */
  migrationFramework?: string;

  /**
   * Name of table to use as migration table
   */
  migrationTableName?: string;

  /**
   * The database cluster size (required)
   */
  clusterSize: PlanetScaleClusterSize;
}

/**
 * Represents a PlanetScale Database
 */
export interface Database
  extends Resource<"planetscale::Database">,
    DatabaseProps {
  /**
   * The unique identifier of the database
   */
  id: string;

  /**
   * The current state of the database
   */
  state: string;

  /**
   * The default branch name
   */
  defaultBranch: string;

  /**
   * The plan type
   */
  plan: string;

  /**
   * Time at which the database was created
   */
  createdAt: string;

  /**
   * Time at which the database was last updated
   */
  updatedAt: string;

  /**
   * HTML URL to access the database
   */
  htmlUrl: string;
}

/**
 * PlanetScale API client configuration
 */
export interface PlanetScaleApiOptions {
  /**
   * API token for authentication
   */
  apiToken?: string;
}

/**
 * Minimal PlanetScale API client
 */
export class PlanetScaleApi {
  private readonly baseUrl = "https://api.planetscale.com/v1";
  private readonly apiToken: string;

  constructor(options: PlanetScaleApiOptions = {}) {
    this.apiToken = options.apiToken || process.env.PLANETSCALE_API_TOKEN || "";
    if (!this.apiToken) {
      throw new Error("PLANETSCALE_API_TOKEN environment variable is required");
    }
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `${this.apiToken}`,
      ...init.headers,
    };

    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
  }

  async get(path: string): Promise<Response> {
    return this.fetch(path, { method: "GET" });
  }

  async post(path: string, body?: any): Promise<Response> {
    return this.fetch(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async put(path: string, body?: any): Promise<Response> {
    return this.fetch(path, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async patch(path: string, body: any): Promise<Response> {
    return this.fetch(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async delete(path: string): Promise<Response> {
    return this.fetch(path, { method: "DELETE" });
  }
}

/**
 * Create, manage and delete PlanetScale databases
 *
 * @example
 * // Create a basic database in a specific organization
 * const db = await Database("my-app-db", {
 *   name: "my-app-db",
 *   organizationId: "my-org",
 *   clusterSize: "PS_10"
 * });
 *
 * @example
 * // Create a database with specific region and settings
 * const db = await Database("my-app-db", {
 *   name: "my-app-db",
 *   organizationId: "my-org",
 *   region: {
 *     slug: "us-east"
 *   },
 *   clusterSize: "PS_10",
 *   requireApprovalForDeploy: true,
 *   allowDataBranching: true,
 *   automaticMigrations: true
 * });
 *
 * @example
 * // Update database settings
 * const db = await Database("my-app-db", {
 *   name: "my-app-db",
 *   organizationId: "my-org",
 *   defaultBranch: "main",
 *   requireApprovalForDeploy: true,
 *   migrationFramework: "rails",
 *   migrationTableName: "schema_migrations"
 * });
 */
export const Database = Resource(
  "planetscale::Database",
  async function (
    this: Context<Database>,
    _id: string,
    props: DatabaseProps,
  ): Promise<Database> {
    const api = new PlanetScaleApi();

    if (this.phase === "delete") {
      try {
        if (this.output?.name) {
          const response = await api.delete(
            `/organizations/${props.organizationId}/databases/${this.output.name}`,
          );

          if (!response.ok && response.status !== 404) {
            throw new Error(
              `Failed to delete database: ${response.statusText} ${await response.text()}`,
            );
          }
        }
      } catch (error) {
        console.error("Error deleting database:", error);
        throw error;
      }
      return this.destroy();
    }

    try {
      // Check if database exists
      const getResponse = await api.get(
        `/organizations/${props.organizationId}/databases/${props.name}`,
      );
      const getData = await getResponse.json<any>();
      if (this.phase === "update" || (props.adopt && getResponse.ok)) {
        if (!getResponse.ok) {
          throw new Error(`Database ${props.name} not found`);
        }
        // Update database settings
        // If updating to a non-'main' default branch, create it first
        if (props.defaultBranch && props.defaultBranch !== "main") {
          const branchResponse = await api.get(
            `/organizations/${props.organizationId}/databases/${props.name}/branches/${props.defaultBranch}`,
          );
          if (!getData.ready) {
            await waitForDatabaseReady(api, props.organizationId, props.name);
          }
          if (!branchResponse.ok && branchResponse.status === 404) {
            // Create the branch
            const createBranchResponse = await api.post(
              `/organizations/${props.organizationId}/databases/${props.name}/branches`,
              {
                name: props.defaultBranch,
                parent_branch: "main",
              },
            );

            if (!createBranchResponse.ok) {
              throw new Error(
                `Failed to create default branch: ${createBranchResponse.statusText} ${await createBranchResponse.text()}`,
              );
            }
          }
        }

        const updateResponse = await api.patch(
          `/organizations/${props.organizationId}/databases/${props.name}`,
          {
            automatic_migrations: props.automaticMigrations,
            migration_framework: props.migrationFramework,
            migration_table_name: props.migrationTableName,
            require_approval_for_deploy: props.requireApprovalForDeploy,
            restrict_branch_region: props.restrictBranchRegion,
            allow_data_branching: props.allowDataBranching,
            insights_raw_queries: props.insightsRawQueries,
            production_branch_web_console: props.productionBranchWebConsole,
            default_branch: props.defaultBranch,
          },
        );

        if (!updateResponse.ok) {
          throw new Error(
            `Failed to update database: ${updateResponse.statusText} ${await updateResponse.text()}`,
          );
        }

        await fixClusterSize(
          api,
          props.organizationId,
          props.name,
          props.defaultBranch || "main",
          props.clusterSize,
          getData.ready,
        );

        const data = await updateResponse.json<any>();
        return this({
          ...props,
          id: data.id,
          state: data.state,
          defaultBranch: data.default_branch,
          plan: data.plan,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
          htmlUrl: data.html_url,
        });
      }

      if (getResponse.ok) {
        throw new Error(`Database with name ${props.name} already exists`);
      }

      // Create new database
      const createResponse = await api.post(
        `/organizations/${props.organizationId}/databases`,
        {
          name: props.name,
          region_slug: props.region?.slug,
          require_approval_for_deploy: props.requireApprovalForDeploy,
          allow_data_branching: props.allowDataBranching,
          automatic_migrations: props.automaticMigrations,
          restrict_branch_region: props.restrictBranchRegion,
          insights_raw_queries: props.insightsRawQueries,
          production_branch_web_console: props.productionBranchWebConsole,
          migration_framework: props.migrationFramework,
          migration_table_name: props.migrationTableName,
          cluster_size: props.clusterSize,
        },
      );

      if (!createResponse.ok) {
        throw new Error(
          `Failed to create database: ${createResponse.statusText} ${await createResponse.text()}`,
        );
      }

      const data = await createResponse.json<any>();

      // If a non-'main' default branch is specified, create it
      if (props.defaultBranch && props.defaultBranch !== "main") {
        await waitForDatabaseReady(api, props.organizationId, props.name);

        // Check if branch exists
        const branchResponse = await api.get(
          `/organizations/${props.organizationId}/databases/${props.name}/branches/${props.defaultBranch}`,
        );

        if (!branchResponse.ok && branchResponse.status === 404) {
          // Create the branch
          const createBranchResponse = await api.post(
            `/organizations/${props.organizationId}/databases/${props.name}/branches`,
            {
              name: props.defaultBranch,
              parent_branch: "main",
            },
          );

          if (!createBranchResponse.ok) {
            throw new Error(
              `Failed to create default branch: ${createBranchResponse.statusText} ${await createBranchResponse.text()}`,
            );
          }

          await fixClusterSize(
            api,
            props.organizationId,
            props.name,
            props.defaultBranch || "main",
            props.clusterSize,
            false,
          );

          // Update database to use new branch as default
          const updateResponse = await api.patch(
            `/organizations/${props.organizationId}/databases/${props.name}`,
            {
              default_branch: props.defaultBranch,
            },
          );

          if (!updateResponse.ok) {
            throw new Error(
              `Failed to set default branch: ${updateResponse.statusText} ${await updateResponse.text()}`,
            );
          }

          const updatedData = await updateResponse.json<any>();
          return this({
            ...props,
            id: data.id,
            state: updatedData.state,
            defaultBranch: updatedData.default_branch,
            plan: updatedData.plan,
            createdAt: updatedData.created_at,
            updatedAt: updatedData.updated_at,
            htmlUrl: updatedData.html_url,
          });
        }
      }

      return this({
        ...props,
        id: data.id,
        state: data.state,
        defaultBranch: data.default_branch || "main",
        plan: data.plan,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        htmlUrl: data.html_url,
      });
    } catch (error) {
      console.error("Error managing database:", error);
      throw error;
    }
  },
);
