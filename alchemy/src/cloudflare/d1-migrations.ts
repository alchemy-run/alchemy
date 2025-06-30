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
  const createTableSQL = `CREATE TABLE IF NOT EXISTS ${options.migrationsTable} (id TEXT PRIMARY KEY, applied_at TEXT);`;

  await executeD1SQL(options, createTableSQL);
}

/**
 * Gets the list of applied migration IDs from the migrations table.
 */
export async function getAppliedMigrations(
  options: D1MigrationOptions,
): Promise<Set<string>> {
  const sql = `SELECT id FROM ${options.migrationsTable};`;

  const result = await executeD1SQL(options, sql);

  const ids = (result?.result[0]?.results || []).map((row: any) => row.id);
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

  // Helper to create a 5-digit, zero-padded ID (Wrangler style)
  const padId = (n: number): string => n.toString().padStart(5, "0");

  // Build a lookup of numeric IDs we have already seen ("00001", "00002", …)
  const appliedNumericIds = new Set(
    [...applied].filter((id) => /^\d+$/.test(id)),
  );

  let sequence = appliedNumericIds.size; // how many numeric IDs already exist

  for (const migration of options.migrationsFiles) {
    sequence += 1;
    const numericId = padId(sequence);

    // Consider the migration already applied if EITHER the numeric ID or the
    // filename-based ID exists in the migrations table.
    if (applied.has(numericId) || applied.has(migration.id)) {
      // If we skipped because the numeric ID is taken we must keep the counter
      // in sync so continue without spraying gaps.
      continue;
    }

    // Run the migration SQL against D1
    await executeD1SQL(options, migration.sql);

    // Record the migration using the deterministic numeric ID
    const insertSQL = `INSERT INTO ${options.migrationsTable} (id, applied_at) VALUES ('${numericId}', datetime('now'));`;
    await executeD1SQL(options, insertSQL);
    logger.log(`Applied migration: ${migration.id}  ->  ${numericId}`);
  }

  logger.log("All migrations applied successfully");
}
