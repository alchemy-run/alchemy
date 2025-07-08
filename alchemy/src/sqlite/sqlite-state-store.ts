import type { Config as LibSQLConfig } from "@libsql/client";
import type { Options as BetterSQLite3Options } from "better-sqlite3";
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Scope } from "../scope.ts";
import { memoize } from "../util/memoize.ts";
import {
  BaseSQLiteStateStore,
  resolveMigrationsPath,
} from "./base-sqlite-state-store.ts";
import * as schema from "./schema.ts";

type BunSQLiteOptions = ConstructorParameters<typeof Database>[1];

interface BaseSQLiteStateStoreOptions {
  /**
   * Whether to retain the database file after the state store is destroyed.
   * @default false
   */
  retain?: boolean;
}

interface BunSQLiteStateStoreOptions extends BaseSQLiteStateStoreOptions {
  engine: "bun";
  filename?: string;
  options?: BunSQLiteOptions;
}

interface BetterSQLite3StateStoreOptions extends BaseSQLiteStateStoreOptions {
  engine: "better-sqlite3";
  filename?: string;
  options?: BetterSQLite3Options;
}

interface LibSQLStateStoreOptions extends BaseSQLiteStateStoreOptions {
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
      create: async () => createDatabase(options),
    });
  }
}

const createDatabase = memoize(
  async (options: SQLiteStateStoreOptions | undefined) => {
    let result;
    switch (options?.engine) {
      case "bun":
        result = await createBunSQLiteDatabase(
          options.filename,
          options.options,
        );
        break;
      case "better-sqlite3":
        result = await createBetterSQLite3Database(
          options.filename,
          options.options,
        );
        break;
      case "libsql":
        result = await createLibSQLDatabase(options.options);
        break;
      default: {
        result = await createDefaultDatabase();
        break;
      }
    }
    if (options?.retain) {
      return { db: result.db };
    }
    return result;
  },
);

const isPeerInstalled = (name: string) =>
  import(name).then(() => true).catch(() => false);

const assertPeers = async (names: string[]) => {
  const missing = await Promise.all(
    names.filter((name) => !isPeerInstalled(name)),
  );
  if (missing.length > 0) {
    throw new Error(
      `[SQLiteStateStore] Missing peer dependencies: ${missing.join(", ")}`,
    );
  }
};

async function createDefaultDatabase() {
  if (await isPeerInstalled("bun:sqlite")) {
    return createBunSQLiteDatabase();
  }
  if (await isPeerInstalled("@libsql/client")) {
    return createLibSQLDatabase();
  }
  if (await isPeerInstalled("better-sqlite3")) {
    return createBetterSQLite3Database();
  }
  const hasDrizzle = await isPeerInstalled("drizzle-orm");
  throw new Error(
    `No supported SQLite engine found for SQLiteStateStore. Please install ${hasDrizzle ? "" : "`drizzle-orm` and "} \`@libsql/client\` or \`better-sqlite3\`.`,
  );
}

async function createBunSQLiteDatabase(
  filename: string = process.env.ALCHEMY_STATE_FILE ?? ".alchemy/state.sqlite",
  options?: BunSQLiteOptions,
) {
  await assertPeers(["drizzle-orm", "bun:sqlite"]);
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
    destroy:
      filename && !options?.retain
        ? () => fs.promises.unlink(filename)
        : undefined,
  };
}

async function createBetterSQLite3Database(
  filename: string = process.env.ALCHEMY_STATE_FILE ?? ".alchemy/state.sqlite",
  options?: BetterSQLite3Options,
) {
  await assertPeers(["drizzle-orm", "better-sqlite3"]);
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
  await assertPeers(["drizzle-orm", "@libsql/client"]);
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
