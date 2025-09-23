import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { logger } from "../util/logger.ts";
import { handleApiError } from "./api-error.ts";
import { createNeonApi, type Neon, type NeonApiOptions } from "./api.ts";
import {
  formatConnectionUri,
  type NeonConnectionUri,
} from "./connection-uri.ts";

/**
 * A Neon region where projects can be provisioned
 */
export type NeonRegion =
  | "aws-us-east-1"
  | "aws-us-east-2"
  | "aws-us-west-2"
  | "aws-eu-central-1"
  | "aws-eu-west-2"
  | "aws-ap-southeast-1"
  | "aws-ap-southeast-2"
  | "aws-sa-east-1"
  | "azure-eastus2"
  | "azure-westus3"
  | "azure-gwc";

/**
 * Properties for creating or updating a Neon project
 */
export interface NeonProjectProps extends NeonApiOptions {
  /**
   * Name of the project
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;

  /**
   * Region where the project will be provisioned
   * @default "aws-us-east-1"
   */
  region_id?: NeonRegion;

  /**
   * PostgreSQL version to use
   * @default 16
   */
  pg_version?: 14 | 15 | 16 | 17;

  /**
   * Whether to create a default branch and endpoint
   * @default true
   */
  default_endpoint?: boolean;

  /**
   * Default branch name
   * @default "main"
   */
  default_branch_name?: string;

  /**
   * Existing project ID to update
   * Used internally during update operations
   * @internal
   */
  existing_project_id?: string;
}

/**
 * API response structure for Neon projects
 */
interface NeonApiResponse {
  project: Neon.Project;
  connection_uris?: Array<Neon.ConnectionDetails>;
  roles?: Array<Neon.Role>;
  databases?: Array<Neon.Database>;
  operations?: Array<Neon.Operation>;
  branch?: Neon.Branch;
  endpoints?: Array<Neon.Endpoint>;
}

/**
 * Output returned after Neon project creation/update
 * IMPORTANT: The interface name MUST match the exported resource name
 */
export interface NeonProject
  extends Resource<"neon::Project">,
    Omit<NeonProjectProps, "apiKey" | "existing_project_id"> {
  /**
   * The ID of the project
   */
  id: string;

  /**
   * Name of the Project.
   */
  name: string;

  /**
   * Time at which the project was created
   */
  created_at: string;

  /**
   * Time at which the project was last updated
   */
  updated_at: string;

  /**
   * Hostname for proxy access
   */
  proxy_host?: string;

  /**
   * Connection URIs for the databases
   */
  connection_uris: [NeonConnectionUri, ...NeonConnectionUri[]];

  /**
   * Database roles created with the project
   */
  roles: [Neon.Role, ...Neon.Role[]];

  /**
   * Databases created with the project
   */
  databases?: [Neon.Database, ...Neon.Database[]];

  /**
   * Default branch information
   */
  branch?: Neon.Branch;

  /**
   * Compute endpoints for the project
   */
  endpoints: [Neon.Endpoint, ...Neon.Endpoint[]];
}

/**
 * Creates a Neon serverless PostgreSQL project.
 *
 * @example
 * // Create a basic Neon project with default settings:
 * const project = await NeonProject("my-project", {
 *   name: "My Project"
 * });
 *
 * @example
 * // Create a Neon project in a specific region with a specific PostgreSQL version:
 * const euProject = await NeonProject("my-eu-project", {
 *   name: "My EU Project",
 *   region_id: "aws-eu-west-1",
 *   pg_version: 16,
 *   apiKey: alchemy.secret(process.env.NEON_API_KEY)
 * });
 *
 * @example
 * // Create a Neon project with a custom default branch name:
 * const devProject = await NeonProject("dev-project", {
 *   name: "Development Project",
 *   default_branch_name: "development"
 * });
 */
export const NeonProject = Resource(
  "neon::Project",
  async function (
    this: Context<NeonProject>,
    id: string,
    props: NeonProjectProps,
  ): Promise<NeonProject> {
    const api = createNeonApi(props);
    const projectId = props.existing_project_id || this.output?.id;
    const projectName =
      props.name ?? this.output?.name ?? this.scope.createPhysicalName(id);

    if (this.phase === "update" && this.output.name !== projectName) {
      this.replace();
    }

    if (this.phase === "delete") {
      try {
        // Check if the project exists before attempting to delete
        if (projectId) {
          const deleteResponse = await api.delete(`/projects/${projectId}`);
          if (!deleteResponse.ok && deleteResponse.status !== 404) {
            await handleApiError(deleteResponse, "delete", "project", id);
          }
        }
      } catch (error) {
        logger.error(`Error deleting Neon project ${id}:`, error);
        throw error;
      }
      return this.destroy();
    }

    let response: NeonApiResponse;

    try {
      if (this.phase === "update" && projectId) {
        // Update existing project
        // Neon only allows updating the project name
        const projectResponse = await api.patch(`/projects/${projectId}`, {
          project: {
            name: projectName,
          },
        });

        if (!projectResponse.ok) {
          await handleApiError(projectResponse, "update", "project", id);
        }

        const initialData = await projectResponse.json();

        // Reify project properties to get complete data
        response = await getProject(
          api,
          projectId,
          initialData as Partial<NeonApiResponse>,
        );
      } else {
        // Check if a project with this ID already exists
        if (projectId) {
          const getResponse = await api.get(`/projects/${projectId}`);
          if (getResponse.ok) {
            // Project exists, update it
            const projectResponse = await api.patch(`/projects/${projectId}`, {
              project: {
                name: projectName,
              },
            });

            if (!projectResponse.ok) {
              await handleApiError(projectResponse, "update", "project", id);
            }

            const initialData = await projectResponse.json();
            // Reify project properties to get complete data
            response = await getProject(
              api,
              projectId,
              initialData as Partial<NeonApiResponse>,
            );
          } else if (getResponse.status !== 404) {
            // Unexpected error during GET check
            await handleApiError(getResponse, "get", "project", id);
            throw new Error("Failed to check if project exists");
          } else {
            // Project doesn't exist, create new
            response = await createNewProject(api, projectName, props);
          }
        } else {
          // No output ID, create new project
          response = await createNewProject(api, projectName, props);
        }
      }

      // Wait for any pending operations to complete
      if (response.operations && response.operations.length > 0) {
        await waitForOperations(api, response.operations);
      }

      // Get the latest project state after operations complete
      if (response.project?.id) {
        // Reify project properties to get complete data
        response = await getProject(api, response.project.id, response);
      }

      return this({
        id: response.project.id,
        name: response.project.name,
        region_id: response.project.region_id as NeonRegion,
        pg_version: response.project.pg_version as 14 | 15 | 16 | 17,
        created_at: response.project.created_at,
        updated_at: response.project.updated_at,
        proxy_host: response.project.proxy_host,
        // Pass through the provided props except apiKey (which is sensitive)
        default_endpoint: props.default_endpoint,
        default_branch_name: props.default_branch_name,
        baseUrl: props.baseUrl,
        // Add all available data
        // @ts-expect-error - api ensures they're non-empty
        connection_uris: response.connection_uris,
        // @ts-expect-error
        roles: response.roles,
        // @ts-expect-error
        databases: response.databases,
        branch: response.branch,
        // @ts-expect-error
        endpoints: response.endpoints,
      });
    } catch (error) {
      logger.error(`Error ${this.phase} Neon project '${id}':`, error);
      throw error;
    }
  },
);

/**
 * Helper function to create a new Neon project
 */
async function createNewProject(
  api: any,
  projectName: string,
  props: NeonProjectProps,
): Promise<NeonApiResponse> {
  const defaultEndpoint = props.default_endpoint ?? true;
  const projectResponse = await api.post("/projects", {
    project: {
      name: projectName,
      region_id: props.region_id || "aws-us-east-1",
      pg_version: props.pg_version || 16,
      default_endpoint: defaultEndpoint,
      branch: defaultEndpoint
        ? { name: props.default_branch_name || "main" }
        : undefined,
    },
  });

  if (!projectResponse.ok) {
    await handleApiError(projectResponse, "create", "project");
  }

  return (await projectResponse.json()) as NeonApiResponse;
}

/**
 * Helper function to get complete project details by fetching all related data
 *
 * @param api The Neon API client
 * @param projectId The project ID
 * @param initialData Initial project data (optional)
 * @returns Complete project data with all related resources
 */
async function getProject(
  api: any,
  projectId: string,
  initialData: Partial<NeonApiResponse> = {},
): Promise<NeonApiResponse> {
  // Get the latest project details
  const updatedData = await getProjectDetails(api, projectId);

  // Start with a copy of the initial data
  const responseData = { ...initialData };

  // Check if we have a branch ID from the initial data
  const branchId = initialData.branch?.id;

  if (branchId) {
    // Get the branch details
    const branchData = await getBranchDetails(api, projectId, branchId);

    // Update with the latest branch data
    responseData.branch = branchData.branch;

    // Also fetch the latest endpoint details for this branch
    const endpointData = await getEndpointDetails(api, projectId, branchId);

    // Update with the latest endpoint data if available
    if (endpointData.endpoints && endpointData.endpoints.length > 0) {
      responseData.endpoints = endpointData.endpoints;
    }
  }

  // Preserve all data from the original response
  // Only update properties that might have changed during operations
  return {
    ...responseData,
    connection_uris: (
      updatedData.connection_uris || responseData.connection_uris
    )?.map((uri) => formatConnectionUri(uri)),
    project: updatedData.project,
    branch: updatedData.branch || responseData.branch,
    endpoints: updatedData.endpoints || responseData.endpoints,
  } as NeonApiResponse;
}

/**
 * Wait for operations to complete
 *
 * @param api The Neon API client
 * @param operations Operations to wait for
 * @throws Error if an operation fails or times out
 * @returns Promise that resolves when all operations complete
 */
async function waitForOperations(
  api: any,
  operations: Array<{
    id: string;
    project_id: string;
    status: string;
    action: string;
  }>,
): Promise<void> {
  const pendingOperations = operations.filter(
    (op) => op.status !== "finished" && op.status !== "failed",
  );

  if (pendingOperations.length === 0) {
    return;
  }

  // Maximum wait time in milliseconds (5 minutes)
  const maxWaitTime = 5 * 60 * 1000;
  // Initial delay between retries in milliseconds
  const initialRetryDelay = 500;
  // Maximum delay between retries
  const maxRetryDelay = 10000;
  // Backoff factor for exponential backoff
  const backoffFactor = 1.5;

  for (const operation of pendingOperations) {
    let totalWaitTime = 0;
    let retryDelay = initialRetryDelay;
    let operationStatus = operation.status;

    while (
      operationStatus !== "finished" &&
      operationStatus !== "failed" &&
      totalWaitTime < maxWaitTime
    ) {
      // Wait before checking again with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      totalWaitTime += retryDelay;

      // Increase delay for next retry with exponential backoff, up to max
      retryDelay = Math.min(retryDelay * backoffFactor, maxRetryDelay);

      // Check operation status
      const operationResponse = await api.get(
        `/projects/${operation.project_id}/operations/${operation.id}`,
      );

      if (operationResponse.ok) {
        const operationData = await operationResponse.json();
        operationStatus = operationData.operation?.status;
      } else {
        throw new Error(
          `Failed to check operation ${operation.id} status: HTTP ${operationResponse.status}`,
        );
      }
    }

    if (operationStatus === "failed") {
      throw new Error(`Operation ${operation.id} (${operation.action}) failed`);
    }
    if (totalWaitTime >= maxWaitTime) {
      throw new Error(
        `Timeout waiting for operation ${operation.id} (${operation.action}) to complete`,
      );
    }
  }

  // Explicitly return when all operations are complete
  return;
}

/**
 * Get the latest project details
 *
 * @param api The Neon API client
 * @param projectId The project ID
 * @returns Project details including branch and endpoints
 * @throws Error if project details cannot be retrieved
 */
async function getProjectDetails(
  api: any,
  projectId: string,
): Promise<NeonApiResponse> {
  const response = await api.get(`/projects/${projectId}`);

  if (!response.ok) {
    throw new Error(`Failed to get project details: HTTP ${response.status}`);
  }

  return (await response.json()) as NeonApiResponse;
}

/**
 * Get the latest branch details
 *
 * @param api The Neon API client
 * @param projectId The project ID
 * @param branchId The branch ID
 * @returns Branch details
 * @throws Error if branch details cannot be retrieved
 */
async function getBranchDetails(
  api: any,
  projectId: string,
  branchId: string,
): Promise<{ branch: Neon.Branch }> {
  const response = await api.get(`/projects/${projectId}/branches/${branchId}`);

  if (!response.ok) {
    throw new Error(`Failed to get branch details: HTTP ${response.status}`);
  }

  return (await response.json()) as { branch: Neon.Branch };
}

/**
 * Get the latest endpoint details for a branch
 *
 * @param api The Neon API client
 * @param projectId The project ID
 * @param branchId The branch ID
 * @returns Endpoint details for the branch
 * @throws Error if endpoint details cannot be retrieved
 */
async function getEndpointDetails(
  api: any,
  projectId: string,
  branchId: string,
): Promise<{ endpoints: Neon.Endpoint[] }> {
  const response = await api.get(
    `/projects/${projectId}/branches/${branchId}/endpoints`,
  );

  if (!response.ok) {
    throw new Error(`Failed to get endpoint details: HTTP ${response.status}`);
  }

  return (await response.json()) as { endpoints: Neon.Endpoint[] };
}
