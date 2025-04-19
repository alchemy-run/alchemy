import * as fs from "fs/promises";
import * as path from "node:path";
import { CloudflareApi } from "./api";
import { handleApiError } from "./api-error";

export interface D1MigrationOptions {
  migrationsDir: string;
  migrationsTable: string;
  accountId: string;
  databaseId: string;
  api: CloudflareApi;
}

const getPrefix = (name: string) => {
  const prefix = name.split("_")[0];
  const num = parseInt(prefix, 10);
  return isNaN(num) ? null : num;
};

/**
 * Reads migration SQL files from the migrationsDir, sorted by filename.
 */
export async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const files = await fs.readdir(migrationsDir);

  return files
    .filter((f: string) => f.endsWith(".sql"))
    .sort((a: string, b: string) => {

      const aNum = getPrefix(a);
      const bNum = getPrefix(b);

      if (aNum !== null && bNum !== null) {
        return aNum - bNum;
      } else if (aNum !== null) {
        return -1;
      } else if (bNum !== null) {
        return 1;
      }

      return a.localeCompare(b);
    });
}

/**
 * Reads the contents of a SQL migration file.
 */
export async function readMigrationFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

/**
 * Ensures the migrations table exists in the D1 database.
 */
export async function ensureMigrationsTable(options: D1MigrationOptions): Promise<void> {
  const createTableSQL = `CREATE TABLE IF NOT EXISTS ${options.migrationsTable} (id TEXT PRIMARY KEY, applied_at TEXT);`;
  await executeD1SQL(options, createTableSQL);
}

/**
 * Gets the list of applied migration IDs from the migrations table.
 */
export async function getAppliedMigrations(options: D1MigrationOptions): Promise<Set<string>> {
  const sql = `SELECT id FROM ${options.migrationsTable};`;

  const result = await executeD1SQL(options, sql);

  const ids = (result?.result?.results || []).map((row: any) => row.id);
  return new Set(ids);
}

/**
 * Executes a SQL statement against the D1 database using the HTTP API.
 */
export async function executeD1SQL(options: D1MigrationOptions, sql: string): Promise<any> {
  const response = await options.api.post(
    `/accounts/${options.accountId}/d1/database/${options.databaseId}/query`,
    { sql }
  );

  if (!response.ok) {
    await handleApiError(response, "executing migration SQL", "D1 database", options.databaseId);
  }

  return response.json();
}

/**
 * Applies all pending migrations from migrationsDir to the D1 database.
 */
export async function applyMigrations(options: D1MigrationOptions): Promise<void> {
  await ensureMigrationsTable(options);
  const migrationFiles = await listMigrationFiles(options.migrationsDir);
  const applied = await getAppliedMigrations(options);

  for (const file of migrationFiles) {
    const migrationId = path.basename(file);

    if (applied.has(migrationId)) continue;

    const sql = await readMigrationFile(path.join(options.migrationsDir, file));
    
    // Run the migration
    await executeD1SQL(options, sql);
    // Record as applied
    const insertSQL = `INSERT INTO ${options.migrationsTable} (id, applied_at) VALUES ('${migrationId.replace("'", "''")}', datetime('now'));`;
    await executeD1SQL(options, insertSQL);
    console.log(`Applied migration: ${migrationId}`);
  }
}
