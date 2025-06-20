import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import type { Secret } from "../secret.ts";
import { alchemy } from "../alchemy.ts";
import { logger } from "../util/logger.ts";
import { handleApiError } from "./api-error.ts";
import { createPrismaApi, type PrismaApiOptions } from "./api.ts";
import type { PrismaDatabase } from "./database.ts";
import type { PrismaProject } from "./project.ts";

/**
 * Properties for creating a Prisma database connection
 */
export interface PrismaConnectionProps extends PrismaApiOptions {
  /**
   * The project that the database belongs to
   */
  project: string | PrismaProject;

  /**
   * The database to create a connection for
   */
  database: string | PrismaDatabase;

  /**
   * Name of the connection
   */
  name: string;
}

/**
 * Output returned after Prisma database connection creation
 */
export interface PrismaConnection extends Resource<"prisma::Connection"> {
  /**
   * The ID of the connection
   */
  id: string;

  /**
   * The ID of the project
   */
  projectId: string;

  /**
   * The ID of the database this connection belongs to
   */
  databaseId: string;

  /**
   * Name of the connection
   */
  name: string;

  /**
   * Database connection string (sensitive)
   */
  connectionString: Secret;

  /**
   * Time at which the connection was created
   */
  createdAt: string;
}

/**
 * Creates a Prisma database connection string for accessing a database.
 *
 * @example
 * ## Create a database connection
 *
 * ```ts
 * const connection = await PrismaConnection("app-connection", {
 *   project: project,
 *   database: database,
 *   name: "app-production"
 * });
 * ```
 *
 * @example
 * ## Create connection with explicit IDs
 *
 * ```ts
 * const connection = await PrismaConnection("backup-connection", {
 *   project: "project-123",
 *   database: "database-456",
 *   name: "backup-reader"
 * });
 * ```
 *
 * @example
 * ## Access connection string
 *
 * ```ts
 * const connection = await PrismaConnection("my-connection", {
 *   project: project,
 *   database: database,
 *   name: "web-app"
 * });
 *
 * // Use the connection string in your application
 * console.log(await connection.connectionString.unencrypted);
 * ```
 */
export const PrismaConnection = Resource(
  "prisma::Connection",
  async function (
    this: Context<PrismaConnection>,
    id: string,
    props: PrismaConnectionProps,
  ): Promise<PrismaConnection> {
    const api = createPrismaApi(props);
    const projectId =
      typeof props.project === "string" ? props.project : props.project.id;
    const databaseId =
      typeof props.database === "string" ? props.database : props.database.id;
    const connectionId = this.output?.id;

    if (this.phase === "delete") {
      try {
        if (connectionId) {
          const deleteResponse = await api.delete(
            `/projects/${projectId}/databases/${databaseId}/connections/${connectionId}`,
          );
          if (!deleteResponse.ok && deleteResponse.status !== 404) {
            await handleApiError(deleteResponse, "delete", "connection", id);
          }
        }
      } catch (error) {
        logger.error(`Error deleting Prisma connection ${id}:`, error);
        throw error;
      }
      return this.destroy();
    }

    try {
      let connection: any;

      if (this.phase === "update" && connectionId) {
        // Connections are immutable once created, so just return current state
        const connections = await listConnections(api, projectId, databaseId);
        connection = connections.find((c: any) => c.id === connectionId);
        if (!connection) {
          throw new Error(`Connection ${connectionId} not found`);
        }
      } else {
        // Check if connection already exists
        if (connectionId) {
          const connections = await listConnections(api, projectId, databaseId);
          connection = connections.find((c: any) => c.id === connectionId);
          if (!connection) {
            // Connection doesn't exist, create new
            connection = await createNewConnection(
              api,
              projectId,
              databaseId,
              props,
            );
          }
        } else {
          // No output ID, create new connection
          connection = await createNewConnection(
            api,
            projectId,
            databaseId,
            props,
          );
        }
      }

      return this({
        id: connection.id,
        projectId: projectId,
        databaseId: databaseId,
        name: connection.name,
        connectionString: alchemy.secret(connection.connectionString),
        createdAt: connection.createdAt,
      });
    } catch (error) {
      logger.error(`Error ${this.phase} Prisma connection '${id}':`, error);
      throw error;
    }
  },
);

/**
 * Helper function to create a new Prisma database connection
 */
async function createNewConnection(
  api: any,
  projectId: string,
  databaseId: string,
  props: PrismaConnectionProps,
): Promise<any> {
  const connectionResponse = await api.post(
    `/projects/${projectId}/databases/${databaseId}/connections`,
    {
      name: props.name,
    },
  );

  if (!connectionResponse.ok) {
    await handleApiError(connectionResponse, "create", "connection");
  }

  return await connectionResponse.json();
}

/**
 * Helper function to list database connections
 */
async function listConnections(
  api: any,
  projectId: string,
  databaseId: string,
): Promise<any[]> {
  const response = await api.get(
    `/projects/${projectId}/databases/${databaseId}/connections`,
  );

  if (!response.ok) {
    await handleApiError(response, "list", "connections");
  }

  const data = await response.json();
  return data.data || [];
}
