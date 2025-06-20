import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { logger } from "../util/logger.ts";
import { handleApiError } from "./api-error.ts";
import { createPrismaApi, type PrismaApiOptions } from "./api.ts";
import type { PrismaProject } from "./project.ts";

/**
 * Properties for creating or updating a Prisma database
 */
export interface PrismaDatabaseProps extends PrismaApiOptions {
  /**
   * The project that this database belongs to
   */
  project: string | PrismaProject;

  /**
   * Name of the database
   */
  name: string;

  /**
   * Region where the database will be deployed
   * @default "us-east-1"
   */
  region?:
    | "us-east-1"
    | "us-west-1"
    | "eu-west-3"
    | "ap-northeast-1"
    | "ap-southeast-1";

  /**
   * Whether this is the default database for the project
   * @default false
   */
  isDefault?: boolean;
}

/**
 * A Prisma database connection/API key
 */
export interface PrismaDatabaseConnection {
  /**
   * Connection ID
   */
  id: string;

  /**
   * Connection name
   */
  name: string;

  /**
   * Time at which the connection was created
   */
  createdAt: string;

  /**
   * Database connection string
   */
  connectionString: string;
}

/**
 * Output returned after Prisma database creation/update
 */
export interface PrismaDatabase extends Resource<"prisma::Database"> {
  /**
   * The ID of the database
   */
  id: string;

  /**
   * The ID of the project this database belongs to
   */
  projectId: string;

  /**
   * Name of the database
   */
  name: string;

  /**
   * Region where the database is deployed
   */
  region: string | null;

  /**
   * Whether this is the default database for the project
   */
  isDefault: boolean;

  /**
   * Database connection string (only available during creation)
   */
  connectionString?: string;

  /**
   * Database status
   */
  status?: string;

  /**
   * API keys/connections for this database
   */
  apiKeys?: PrismaDatabaseConnection[];

  /**
   * Time at which the database was created
   */
  createdAt: string;
}

/**
 * Creates a Prisma database within a project for data storage and management.
 *
 * @example
 * ## Create a basic database
 *
 * ```ts
 * const database = await PrismaDatabase("my-database", {
 *   project: project,
 *   name: "my-app-db",
 *   region: "us-east-1"
 * });
 * ```
 *
 * @example
 * ## Create a default database
 *
 * ```ts
 * const database = await PrismaDatabase("default-db", {
 *   project: "project-123",
 *   name: "production",
 *   region: "us-east-1",
 *   isDefault: true
 * });
 * ```
 *
 * @example
 * ## Create database with custom region
 *
 * ```ts
 * const database = await PrismaDatabase("eu-database", {
 *   project: project,
 *   name: "eu-production",
 *   region: "eu-west-3"
 * });
 * ```
 */
export const PrismaDatabase = Resource(
  "prisma::Database",
  async function (
    this: Context<PrismaDatabase>,
    id: string,
    props: PrismaDatabaseProps,
  ): Promise<PrismaDatabase> {
    const api = createPrismaApi(props);
    const projectId =
      typeof props.project === "string" ? props.project : props.project.id;
    const databaseId = this.output?.id;

    if (this.phase === "delete") {
      try {
        if (databaseId) {
          const deleteResponse = await api.delete(
            `/projects/${projectId}/databases/${databaseId}`,
          );
          if (!deleteResponse.ok && deleteResponse.status !== 404) {
            await handleApiError(deleteResponse, "delete", "database", id);
          }
        }
      } catch (error) {
        logger.error(`Error deleting Prisma database ${id}:`, error);
        throw error;
      }
      return this.destroy();
    }

    try {
      let database: any;

      if (this.phase === "update" && databaseId) {
        // For databases, we can't update most properties as they're immutable
        // Just return the current state
        const getResponse = await api.get(
          `/projects/${projectId}/databases/${databaseId}`,
        );
        if (!getResponse.ok) {
          await handleApiError(getResponse, "get", "database", id);
        }
        database = await getResponse.json();
      } else {
        // Check if database already exists
        if (databaseId) {
          const getResponse = await api.get(
            `/projects/${projectId}/databases/${databaseId}`,
          );
          if (getResponse.ok) {
            database = await getResponse.json();
          } else if (getResponse.status !== 404) {
            await handleApiError(getResponse, "get", "database", id);
          } else {
            // Database doesn't exist, create new
            database = await createNewDatabase(api, projectId, props);
          }
        } else {
          // No output ID, create new database
          database = await createNewDatabase(api, projectId, props);
        }
      }

      return this({
        id: database.id,
        projectId: projectId,
        name: database.name,
        region: database.region,
        isDefault: database.isDefault,
        connectionString: database.connectionString,
        status: database.status,
        apiKeys: database.apiKeys,
        createdAt: database.createdAt,
      });
    } catch (error) {
      logger.error(`Error ${this.phase} Prisma database '${id}':`, error);
      throw error;
    }
  },
);

/**
 * Helper function to create a new Prisma database
 */
async function createNewDatabase(
  api: any,
  projectId: string,
  props: PrismaDatabaseProps,
): Promise<any> {
  const databaseResponse = await api.post(`/projects/${projectId}/databases`, {
    name: props.name,
    region: props.region || "us-east-1",
    isDefault: props.isDefault || false,
  });

  if (!databaseResponse.ok) {
    await handleApiError(databaseResponse, "create", "database");
  }

  return await databaseResponse.json();
}
