import type { CloudflareApi } from "./api.js";
import {
  exportD1Database,
  type ExportD1DatabaseOptions,
  type ExportD1DatabaseResult,
} from "./d1-export.js";
import {
  importD1Database,
  type ImportD1DatabaseOptions,
  type ImportD1DatabaseResult,
} from "./d1-import.js";

/**
 * Options for cloning a D1 database
 */
export interface CloneD1DatabaseOptions {
  /**
   * The ID of the source D1 database to clone from
   */
  sourceDatabaseId: string;

  /**
   * The ID of the target D1 database to clone to
   */
  targetDatabaseId: string;

  /**
   * Optional export options for the source database
   */
  exportOptions?: Omit<ExportD1DatabaseOptions, "databaseId">;

  /**
   * Optional import options for the target database
   */
  importOptions?: Omit<ImportD1DatabaseOptions, "databaseId" | "sqlData">;
}

/**
 * Response from the clone D1 database operation
 */
export interface CloneD1DatabaseResult {
  /**
   * Result of the export operation
   */
  exportResult: ExportD1DatabaseResult;

  /**
   * Result of the import operation
   */
  importResult: ImportD1DatabaseResult;

  /**
   * Whether the clone operation was successful
   */
  success: boolean;
}

/**
 * Clones a D1 database by exporting from a source database and importing to a target database.
 * Handles the full workflow:
 * 1. Export source database to get a signed URL
 * 2. Fetch SQL content from the signed URL
 * 3. Import SQL content into the target database
 *
 * @param api The CloudflareApi instance to use for requests
 * @param options Options including source and target database IDs
 * @returns An object containing results from both export and import operations
 * @throws Will throw an error if any part of the clone process fails
 */
export async function cloneD1Database(
  api: CloudflareApi,
  options: CloneD1DatabaseOptions,
): Promise<CloneD1DatabaseResult> {
  const exportResult = await exportD1Database(api, {
    databaseId: options.sourceDatabaseId,
    ...options.exportOptions,
  });

  if (!exportResult.success) {
    throw new Error(
      `Failed to export source database: ${options.sourceDatabaseId}`,
    );
  }

  // Step 2: Fetch SQL content from the signed URL
  const sqlResponse = await fetch(exportResult.signed_url);

  if (!sqlResponse.ok) {
    throw new Error(`Failed to fetch SQL content: ${sqlResponse.statusText}`);
  }

  const sqlData = await sqlResponse.text();

  // Step 3: Import SQL content into target database
  const importResult = await importD1Database(api, {
    databaseId: options.targetDatabaseId,
    sqlData,
    filename: exportResult.filename,
    ...options.importOptions,
  });

  if (!importResult.success) {
    throw new Error(
      `Failed to import to target database: ${options.targetDatabaseId}`,
    );
  }

  return {
    exportResult,
    importResult,
    success: true,
  };
}
