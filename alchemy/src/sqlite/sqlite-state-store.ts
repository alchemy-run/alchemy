import type { Config as LibSQLConfig } from "@libsql/client";
import type { Options as BetterSQLite3Options } from "better-sqlite3";
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Scope } from "../scope.ts";
import {
  BaseSQLiteStateStore,
  resolveMigrationsPath,
} from "./internal/base-sqlite-state-store.ts";
import * as schema from "./internal/schema.ts";

type BunSQLiteOptions = ConstructorParameters<typeof Database>[1];

interface BunSQLiteStateStoreOptions {
  engine: "bun";
  filename?: string;
  options?: BunSQLiteOptions;
}

interface BetterSQLite3StateStoreOptions {
  engine: "better-sqlite3";
  filename?: string;
  options?: BetterSQLite3Options;
}

interface LibSQLStateStoreOptions {
  engine: "libsql";
  options?: LibSQLConfig;
}

type SQLiteStateStoreOptions =
  | BunSQLiteStateStoreOptions
  | BetterSQLite3StateStoreOptions
  | LibSQLStateStoreOptions;

export class SQLiteStateStore extends BaseSQLiteStateStore {
  constructor(scope: Scope, options?: SQLiteStateStoreOptions) {
    super(scope, {
      create: async () => {
        switch (options?.engine) {
          case "bun":
            return createBunSQLiteDatabase(options.filename, options.options);
          case "better-sqlite3":
            return createBetterSQLite3Database(
              options.filename,
              options.options,
            );
          case "libsql":
            return createLibSQLDatabase(options.options);
          default: {
            return createDefaultDatabase();
          }
        }
      },
    });
  }
}

async function createDefaultDatabase() {
  try {
    await import("bun:sqlite");
    return createBunSQLiteDatabase();
  } catch {
    //ignore
  }
  try {
    await import("@libsql/client");
    return createLibSQLDatabase();
  } catch {
    //ignore
  }
  try {
    await import("better-sqlite3");
    return createBetterSQLite3Database();
  } catch {
    //ignore
  }
  throw new Error(
    "No supported SQLite engine found for SQLiteStateStore. Please install `@libsql/client` or `better-sqlite3`.",
  );
}

async function createBunSQLiteDatabase(
  filename: string = process.env.ALCHEMY_STATE_FILE ?? ".alchemy/state.sqlite",
  options?: BunSQLiteOptions,
) {
  ensureDirectory(filename);
  const { Database } = await import("bun:sqlite");
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
  const db = drizzle(new Database(filename, options), {
    schema,
  });
  migrate(db, { migrationsFolder: resolveMigrationsPath() });
  return {
    db,
    destroy: filename ? () => fs.promises.unlink(filename) : undefined,
  };
}

async function createBetterSQLite3Database(
  filename: string = process.env.ALCHEMY_STATE_FILE ?? ".alchemy/state.sqlite",
  options?: BetterSQLite3Options,
) {
  ensureDirectory(filename);
  const { default: Client } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const db = drizzle(new Client(filename, options), {
    schema,
  });
  migrate(db, { migrationsFolder: resolveMigrationsPath() });
  return {
    db,
    destroy: filename ? () => fs.promises.unlink(filename) : undefined,
  };
}

async function createLibSQLDatabase(options?: LibSQLConfig) {
  const url =
    options?.url ??
    `file:${process.env.ALCHEMY_STATE_FILE ?? ".alchemy/state.sqlite"}`;
  const filename = url.startsWith("file:") ? url.slice(5) : undefined;
  if (filename) {
    ensureDirectory(filename);
  }
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  const db = drizzle(createClient({ url, ...options }), {
    schema,
  });
  await migrate(db, { migrationsFolder: resolveMigrationsPath() });
  return {
    db,
    destroy: filename ? () => fs.promises.unlink(filename) : undefined,
  };
}

const ensureDirectory = (filename: string) => {
  const dir = path.dirname(filename);
  if (!fs.existsSync(dir)) {
    console.log("Creating directory", dir);
    fs.mkdirSync(dir, { recursive: true });
  }
};
