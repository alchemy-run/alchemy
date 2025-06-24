import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "../util/logger.ts";
import { handleApiError } from "./api-error.ts";
import type { CloudflareApi } from "./api.ts";

export interface D1MigrationOptions {
  migrationsFiles: Array<{ id: string; sql: string }>;
  migrationsTable: string;
  accountId: string;
  databaseId: string;
  api: CloudflareApi;
  /**
   * Name of the column used to store migration IDs.
   * If not specified, will attempt to detect the column automatically:
   * 1. First checks if 'name' column exists (wrangler compatibility)
   * 2. Falls back to 'id' column (backward compatibility)
   */
  migrationsIdColumn?: string;
}

const getPrefix = (name: string) => {
  const prefix = name.split("_")[0];
  const num = Number.parseInt(prefix, 10);
  return Number.isNaN(num) ? null : num;
};

async function readMigrationFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

/**
 * Detects the migration ID column name used in the migration table.
 * Returns the column name to use for storing migration IDs.
 */
async function detectMigrationIdColumn(
  options: D1MigrationOptions,
): Promise<string> {
  // If explicitly specified, use that
  if (options.migrationsIdColumn) {
    return options.migrationsIdColumn;
  }

  try {
    // Check if the table exists and get its schema
    const pragmaSQL = `PRAGMA table_info(${options.migrationsTable});`;
    const result = await executeD1SQL(options, pragmaSQL);
    const columns = result?.result[0]?.results || [];

    // Look for 'name' column first (wrangler compatibility)
    const hasNameColumn = columns.some((col: any) => col.name === "name");
    if (hasNameColumn) {
      return "name";
    }

    // Look for 'id' column (backward compatibility)
    const hasIdColumn = columns.some((col: any) => col.name === "id");
    if (hasIdColumn) {
      return "id";
    }

    // If table doesn't exist or no recognized columns, default to 'name' for wrangler compatibility
    return "name";
  } catch (error) {
    // If there's an error querying the table (e.g., table doesn't exist), default to 'name'
    return "name";
  }
}

/**
 * Reads migration SQL files from the migrationsDir, sorted by filename.
 * @param migrationsDir Directory containing .sql migration files
 */
export async function listMigrationsFiles(
  migrationsDir: string,
): Promise<Array<{ id: string; sql: string }>> {
  const entries = await fs.readdir(migrationsDir);

  const sqlFiles = entries
    .filter((f: string) => f.endsWith(".sql"))
    .sort((a: string, b: string) => {
      const aNum = getPrefix(a);
      const bNum = getPrefix(b);

      if (aNum !== null && bNum !== null) return aNum - bNum;
      if (aNum !== null) return -1;
      if (bNum !== null) return 1;

      return a.localeCompare(b);
    });

  const files: Array<{ id: string; sql: string }> = [];
  for (const file of sqlFiles) {
    const sql = await readMigrationFile(path.join(migrationsDir, file));
    files.push({ id: file, sql });
  }

  return files;
}

/**
 * Ensures the migrations table exists in the D1 database.
 */
export async function ensureMigrationsTable(
  options: D1MigrationOptions,
): Promise<void> {
  const idColumn = await detectMigrationIdColumn(options);
  const createTableSQL = `CREATE TABLE IF NOT EXISTS ${options.migrationsTable} (${idColumn} TEXT PRIMARY KEY, applied_at TEXT);`;

  await executeD1SQL(options, createTableSQL);
}

/**
 * Gets the list of applied migration IDs from the migrations table.
 */
export async function getAppliedMigrations(
  options: D1MigrationOptions,
): Promise<Set<string>> {
  const idColumn = await detectMigrationIdColumn(options);
  const sql = `SELECT ${idColumn} FROM ${options.migrationsTable};`;

  const result = await executeD1SQL(options, sql);

  const ids = (result?.result[0]?.results || []).map(
    (row: any) => row[idColumn],
  );
  return new Set(ids);
}

/**
 * Executes a SQL statement against the D1 database using the HTTP API.
 */
export async function executeD1SQL(
  options: D1MigrationOptions,
  sql: string,
): Promise<{
  result: [
    {
      results: Array<unknown>;
      success: boolean;
      meta: any;
    },
  ];
  errors: Array<any>;
  messages: Array<any>;
  success: boolean;
}> {
  const response = await options.api.post(
    `/accounts/${options.accountId}/d1/database/${options.databaseId}/query`,
    { sql },
  );

  if (!response.ok) {
    await handleApiError(
      response,
      "executing migration SQL",
      "D1 database",
      options.databaseId,
    );
  }

  return response.json();
}

/**
 * Applies all pending migrations from the provided files to the D1 database.
 */
export async function applyMigrations(
  options: D1MigrationOptions,
): Promise<void> {
  await ensureMigrationsTable(options);
  const applied = await getAppliedMigrations(options);
  const idColumn = await detectMigrationIdColumn(options);

  for (const migration of options.migrationsFiles) {
    const migrationId = migration.id;

    if (applied.has(migrationId)) continue;

    // Run the migration
    await executeD1SQL(options, migration.sql);
    // Record as applied
    const insertSQL = `INSERT INTO ${options.migrationsTable} (${idColumn}, applied_at) VALUES ('${migrationId.replace("'", "''")}', datetime('now'));`;
    await executeD1SQL(options, insertSQL);

    logger.log(`Applied migration: ${migrationId}`);
  }
}
