import type { RemoteCallback } from "drizzle-orm/sqlite-proxy";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import assert from "node:assert";
import crypto from "node:crypto";
import type { CloudflareApi, CloudflareApiOptions } from "../cloudflare/api.ts";
import type { Scope } from "../scope.ts";
import { memoize } from "../util/memoize.ts";
import { BaseSQLiteStateStore } from "./base.ts";
import { migrations } from "./internal/migrations.ts";
import * as schema from "./internal/schema.ts";

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

const createDatabaseClient = memoize(
  async (options: D1StateStoreOptions) => {
    const { createCloudflareApi } = await import("../cloudflare/api.ts");
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
  },
  (options) =>
    crypto.createHash("sha256").update(JSON.stringify(options)).digest("hex"),
);

const upsertDatabase = async (api: CloudflareApi, databaseName: string) => {
  const { listDatabases, createDatabase } = await import(
    "../cloudflare/d1-database.ts"
  );
  const { applyMigrations } = await import("../cloudflare/d1-migrations.ts");
  const databases = await listDatabases(api, databaseName);
  if (databases[0]) {
    return {
      id: databases[0].id,
    };
  }
  const res = await createDatabase(api, databaseName, {
    readReplication: { mode: "disabled" },
  });
  assert(res.result.uuid, "Missing UUID for database");
  await applyMigrations({
    migrationsFiles: migrations.map((it) => ({
      id: it.hash,
      sql: it.sql.join("\n"),
    })),
    migrationsTable: "migrations",
    accountId: api.accountId,
    databaseId: res.result.uuid,
    api,
  });
  return {
    id: res.result.uuid,
  };
};
