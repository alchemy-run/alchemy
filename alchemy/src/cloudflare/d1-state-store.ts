import type { RemoteCallback } from "drizzle-orm/sqlite-proxy";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import assert from "node:assert";
import type { Scope } from "../scope.ts";
import {
  BaseSQLiteStateStore,
  resolveMigrationsPath,
} from "../sqlite/base-sqlite-state-store.ts";
import * as schema from "../sqlite/schema.ts";
import { memoize } from "../util/memoize.ts";
import type { CloudflareApi, CloudflareApiOptions } from "./api.ts";

export interface D1StateStoreOptions extends CloudflareApiOptions {
  databaseName?: string;
}

type D1Response =
  | {
      success: true;
      result: {
        results: { columns: string[]; rows: any[][] };
      }[];
    }
  | {
      success: false;
      errors: { code: number; message: string }[];
    };

export class D1StateStore extends BaseSQLiteStateStore {
  constructor(scope: Scope, options: D1StateStoreOptions = {}) {
    super(scope, {
      create: async () => createDatabaseClient(options),
    });
  }
}

const createDatabaseClient = memoize(async (options: D1StateStoreOptions) => {
  const { createCloudflareApi } = await import("./api.ts");
  const api = await createCloudflareApi(options);
  const database = await upsertDatabase(
    api,
    options.databaseName ?? "alchemy-state",
  );
  const remoteCallback: RemoteCallback = async (sql, params) => {
    const res = await api.post(
      `/accounts/${api.accountId}/d1/database/${database.id}/raw`,
      { sql, params },
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
    const data = (await res.json()) as D1Response;
    if (!data.success) {
      throw new Error(
        data.errors.map((it) => `${it.code}: ${it.message}`).join("\n"),
      );
    }
    const [result] = data.result;
    assert(result, "Missing result");
    return {
      rows: Object.values(result.results.rows),
    };
  };
  return drizzle(remoteCallback, {
    schema,
  });
});

const upsertDatabase = async (api: CloudflareApi, databaseName: string) => {
  const { listDatabases, createDatabase } = await import("./d1-database.ts");
  const { applyMigrations, listMigrationsFiles } = await import(
    "./d1-migrations.ts"
  );
  const databases = await listDatabases(api, databaseName);
  if (databases[0]) {
    await applyMigrations({
      migrationsFiles: await listMigrationsFiles(resolveMigrationsPath()),
      migrationsTable: "migrations",
      accountId: api.accountId,
      databaseId: databases[0].id,
      api,
      quiet: true,
    });
    return {
      id: databases[0].id,
    };
  }
  const res = await createDatabase(api, databaseName, {
    readReplication: { mode: "disabled" },
  });
  assert(res.result.uuid, "Missing UUID for database");
  await applyMigrations({
    migrationsFiles: await listMigrationsFiles(resolveMigrationsPath()),
    migrationsTable: "migrations",
    accountId: api.accountId,
    databaseId: res.result.uuid,
    api,
    quiet: true,
  });
  return {
    id: res.result.uuid,
  };
};
