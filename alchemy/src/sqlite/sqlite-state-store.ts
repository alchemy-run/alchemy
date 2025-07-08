import type { Config as LibSQLConfig } from "@libsql/client";
import type { Options as BetterSQLite3Options } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Scope } from "../scope.ts";
import { memoize } from "../util/memoize.ts";
import {
  BaseSQLiteStateStore,
  resolveMigrationsPath,
} from "./base-sqlite-state-store.ts";
import * as schema from "./schema.ts";

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

  // Options are copied from Bun instead of inherited because Bun's type is not exported,
  // and the constructor type isn't an interface so inheritance doesn't work.

  readonly?: boolean;
  create?: boolean;
  readwrite?: boolean;
  safeIntegers?: boolean;
  strict?: boolean;
}

interface BetterSQLite3StateStoreOptions
  extends BaseSQLiteStateStoreOptions,
    BetterSQLite3Options {
  engine: "better-sqlite3";
  filename?: string;
}

interface LibSQLStateStoreOptions
  extends BaseSQLiteStateStoreOptions,
    LibSQLConfig {
  engine: "libsql";
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
        result = await createBunSQLiteDatabase(options);
        break;
      case "better-sqlite3":
        result = await createBetterSQLite3Database(options);
        break;
      case "libsql":
        result = await createLibSQLDatabase(options);
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

async function createBunSQLiteDatabase(options?: BunSQLiteStateStoreOptions) {
  await assertPeers(["drizzle-orm", "bun:sqlite"]);

  const filename =
    options?.filename ??
    process.env.ALCHEMY_STATE_FILE ??
    ".alchemy/state.sqlite";
  ensureDirectory(filename);
  const { Database } = await import("bun:sqlite");
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
  // Bun's constructor throws if we pass in an empty object or if extraneous
  // options are passed in, so here's some ugly destructuring!
  const {
    engine: _engine,
    filename: _filename,
    retain: _retain,
    ...rest
  } = options ?? {};
  const bunOptions = Object.keys(rest).length > 0 ? rest : undefined;
  const db = drizzle(new Database(filename, bunOptions), {
    schema,
  });
  migrate(db, { migrationsFolder: resolveMigrationsPath() });
  return {
    db,
    destroy: () => fs.promises.unlink(filename),
  };
}

async function createBetterSQLite3Database(
  options?: BetterSQLite3StateStoreOptions,
) {
  await assertPeers(["drizzle-orm", "better-sqlite3"]);
  const filename =
    options?.filename ??
    process.env.ALCHEMY_STATE_FILE ??
    ".alchemy/state.sqlite";
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
    destroy: () => fs.promises.unlink(filename),
  };
}

async function createLibSQLDatabase(options?: LibSQLStateStoreOptions) {
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
