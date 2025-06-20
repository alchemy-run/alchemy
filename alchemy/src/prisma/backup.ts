import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { logger } from "../util/logger.ts";
import { handleApiError } from "./api-error.ts";
import { createPrismaApi, type PrismaApiOptions } from "./api.ts";
import type { PrismaDatabase } from "./database.ts";
import type { PrismaProject } from "./project.ts";

/**
 * Properties for accessing Prisma database backups
 */
export interface PrismaBackupProps extends PrismaApiOptions {
  /**
   * The project that the database belongs to
   */
  project: string | PrismaProject;

  /**
   * The database to access backups for
   */
  database: string | PrismaDatabase;

  /**
   * Optional: Restore a specific backup to a new database
   */
  restore?: {
    /**
     * The backup ID to restore from
     */
    backupId: string;

    /**
     * Name of the new database to restore to
     */
    targetDatabaseName: string;
  };
}

/**
 * A single backup entry
 */
export interface PrismaBackupEntry {
  /**
   * Backup ID
   */
  id: string;

  /**
   * Time when the backup was created
   */
  createdAt: string;

  /**
   * Type of backup (full or incremental)
   */
  backupType: "full" | "incremental";

  /**
   * Size of the backup in bytes
   */
  size: number;

  /**
   * Status of the backup
   */
  status: "running" | "completed" | "failed" | "unknown";
}

/**
 * Backup metadata
 */
export interface PrismaBackupMeta {
  /**
   * Number of days backups are retained
   */
  backupRetentionDays: number;
}

/**
 * Output returned after accessing Prisma database backups
 */
export interface PrismaBackup extends Resource<"prisma::Backup"> {
  /**
   * The ID of the project
   */
  projectId: string;

  /**
   * The ID of the database these backups belong to
   */
  databaseId: string;

  /**
   * List of available backups
   */
  backups: PrismaBackupEntry[];

  /**
   * Backup metadata
   */
  meta: PrismaBackupMeta;

  /**
   * If a restore was requested, the restored database details
   */
  restoredDatabase?: {
    id: string;
    name: string;
    region: string | null;
    isDefault: boolean;
    status: string;
    createdAt: string;
  };
}

/**
 * Accesses Prisma database backups and provides restore functionality.
 * This is a read-only resource that lists available backups and can restore them.
 *
 * @example
 * ## List database backups
 *
 * ```ts
 * const backups = await PrismaBackup("db-backups", {
 *   project: project,
 *   database: database
 * });
 *
 * console.log(`Found ${backups.backups.length} backups`);
 * console.log(`Retention: ${backups.meta.backupRetentionDays} days`);
 * ```
 *
 * @example
 * ## Restore a backup to a new database
 *
 * ```ts
 * const backups = await PrismaBackup("restore-backup", {
 *   project: project,
 *   database: database,
 *   restore: {
 *     backupId: "backup-123",
 *     targetDatabaseName: "restored-production"
 *   }
 * });
 *
 * console.log(`Restored to database: ${backups.restoredDatabase?.id}`);
 * ```
 *
 * @example
 * ## Find latest completed backup
 *
 * ```ts
 * const backups = await PrismaBackup("latest-backup", {
 *   project: "project-123",
 *   database: "database-456"
 * });
 *
 * const latestBackup = backups.backups
 *   .filter(b => b.status === "completed")
 *   .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
 * ```
 */
export const PrismaBackup = Resource(
  "prisma::Backup",
  async function (
    this: Context<PrismaBackup>,
    id: string,
    props: PrismaBackupProps,
  ): Promise<PrismaBackup> {
    const api = createPrismaApi(props);
    const projectId =
      typeof props.project === "string" ? props.project : props.project.id;
    const databaseId =
      typeof props.database === "string" ? props.database : props.database.id;

    if (this.phase === "delete") {
      // Backups are read-only, nothing to delete
      return this.destroy();
    }

    try {
      // Get backups for the database
      const backupResponse = await api.get(
        `/projects/${projectId}/databases/${databaseId}/backups`,
      );

      if (!backupResponse.ok) {
        await handleApiError(backupResponse, "get", "backups", id);
      }

      const backupData = await backupResponse.json();

      let restoredDatabase: any;

      // Handle restore if requested
      if (props.restore && this.phase === "create") {
        const restoreResponse = await api.post(
          `/projects/${projectId}/databases/${databaseId}/backups/${props.restore.backupId}/recoveries`,
          {
            targetDatabaseName: props.restore.targetDatabaseName,
          },
        );

        if (!restoreResponse.ok) {
          await handleApiError(restoreResponse, "restore", "backup", id);
        }

        const restoreData = await restoreResponse.json();
        restoredDatabase = restoreData.data;
      }

      return this({
        projectId: projectId,
        databaseId: databaseId,
        backups: backupData.data || [],
        meta: backupData.meta || { backupRetentionDays: 0 },
        restoredDatabase: restoredDatabase,
      });
    } catch (error) {
      logger.error(`Error ${this.phase} Prisma backup '${id}':`, error);
      throw error;
    }
  },
);
