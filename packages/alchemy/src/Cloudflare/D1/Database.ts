import type { RuntimeServices } from "@alchemy.run/cloudflare-runtime/core";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { isResolved } from "../../Diff.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import {
  applyMigrations as applyResolvedMigrations,
  migrationsInputOf,
  resolveMigrations,
  stampedOf,
  type MigrationFormatTag,
  type MigrationsInput,
  type ResolvedMigrations,
} from "../../SQL/Migrations/index.ts";
import { hashImports, hashMigrations, readSqlFile } from "../../SQL/SqlFile.ts";
import { recordsEqual } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  generateLocalId,
  LOCAL_ENTRY_URL,
  localRuntimeServices,
} from "../LocalRuntime.ts";
import type { Providers } from "../Providers.ts";
import { makeD1MigrationExecutor } from "./ApplyMigrations.ts";
import { cloneDatabase } from "./CloneDatabase.ts";
import { importD1Database } from "./ImportDatabase.ts";
import { withLocalD1Executor } from "./LocalD1Gateway.ts";

export const isDatabase = (value: unknown): value is Database =>
  isResourceOfType(value, "Cloudflare.D1Database");

export type Jurisdiction = "default" | "eu" | "fedramp";
export type PrimaryLocationHint =
  | "wnam"
  | "enam"
  | "weur"
  | "eeur"
  | "apac"
  | "oc";

export type CloneSource = Database | { databaseId: string } | { name: string };

export type DatabaseProps = {
  /**
   * Name of the database. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Region in which the primary copy of the data is stored. Cannot be
   * changed after creation — updating this property triggers a replacement.
   *
   * - `wnam` — Western North America
   * - `enam` — Eastern North America
   * - `weur` — Western Europe
   * - `eeur` — Eastern Europe
   * - `apac` — Asia Pacific
   * - `oc`   — Oceania
   */
  primaryLocationHint?: PrimaryLocationHint;
  /**
   * Read replication configuration. The only mutable property after
   * creation; toggling `mode` triggers an in-place update.
   *
   * @default { mode: "disabled" }
   */
  readReplication?: {
    mode: "auto" | "disabled";
  };
  /**
   * Jurisdiction in which the database data is guaranteed to be stored.
   * Cannot be changed after creation.
   *
   * @default "default"
   */
  jurisdiction?: Jurisdiction;
  /**
   * SQL migrations to apply on deploy. Accepts a directory path, a
   * `Drizzle.Schema` resource, or a `{ dir, format?, table? }` object.
   *
   * The applied-migrations **format** is detected from the directory layout
   * (drizzle-kit v1 dirs → drizzle's own `__drizzle_migrations`
   * bookkeeping; flat `.sql` files → wrangler's `d1_migrations` table, so
   * `wrangler d1 migrations list` interoperates). A database previously
   * migrated with `drizzle-kit migrate` or `wrangler d1 migrations apply`
   * is picked up where the other tool left off — no baselining required.
   *
   * Pending migrations are detected on each deploy and applied in order as
   * part of `update`.
   */
  migrations?: MigrationsInput;
  /**
   * Directory containing `.sql` migration files.
   *
   * @deprecated Use {@link migrations} — `migrations: "./migrations"` is
   * equivalent.
   */
  migrationsDir?: string;
  /**
   * Name of the table used to track applied migrations.
   *
   * @deprecated Use {@link migrations} — `migrations: { dir, table }`.
   * @default the resolved format's table (`d1_migrations` for flat dirs,
   * `__drizzle_migrations` for drizzle-kit dirs)
   */
  migrationsTable?: string;
  /**
   * Paths to additional `.sql` files to import after migrations are
   * applied. Each file is uploaded via Cloudflare's D1 import API and
   * hashed; only files whose contents change are re-imported on subsequent
   * deploys.
   *
   * @see https://developers.cloudflare.com/d1/best-practices/import-export-data/
   */
  importFiles?: string[];
  /**
   * Clone data from an existing database during creation by exporting the
   * source and importing it into the new database. Only applied during the
   * `create` phase.
   *
   * Accepts:
   * - another `D1Database` resource (uses its `databaseId`)
   * - `{ databaseId }` — clone by explicit UUID
   * - `{ name }` — look up the source by name and clone it
   */
  clone?: CloneSource;
};

export type Database = Resource<
  "Cloudflare.D1Database",
  DatabaseProps,
  {
    databaseId: string;
    databaseName: string;
    jurisdiction: Jurisdiction;
    readReplication: { mode: "auto" | "disabled" } | undefined;
    accountId: string;
    migrationsDir: string | undefined;
    migrationsTable: string | undefined;
    migrationsFormat: MigrationFormatTag | undefined;
    migrationsHashes: Record<string, string>;
    importHashes: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Cloudflare D1 serverless SQL database built on SQLite.
 *
 * D1 is a serverless relational database that runs at the edge. Create a
 * database as a resource, then bind it to a Worker to run SQL queries.
 * @resource
 * @product D1
 * @category Storage & Databases
 * @section Creating a Database
 * @example Basic database
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db");
 * ```
 *
 * @example Database with location hint
 * The primary copy of the data is stored in the chosen region; reads can be
 * served closer to users when read replication is enabled.
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   primaryLocationHint: "wnam",
 * });
 * ```
 *
 * @example Database with read replication
 * Read replication is the only mutable property after creation — toggling it
 * triggers an update rather than a replacement.
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   readReplication: { mode: "auto" },
 * });
 * ```
 *
 * @example Database in a specific jurisdiction
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   jurisdiction: "eu",
 * });
 * ```
 *
 * @section Migrations
 * Point `migrations` at a folder of migration files. Already-applied
 * migrations are skipped on subsequent deploys; new files are detected
 * automatically and applied as part of the next update.
 *
 * The bookkeeping format follows the tool that generated the directory.
 * Flat `.sql` files use wrangler's real `d1_migrations` table, so
 * `wrangler d1 migrations list/apply` and Alchemy can interleave freely.
 * drizzle-kit directories delegate to drizzle-orm's own migrator
 * (`__drizzle_migrations`), so a database previously migrated with
 * `drizzle-kit migrate` is picked up where drizzle left off — no
 * baselining required. A legacy Alchemy tracking table is detected by its
 * column shape and upgraded in place.
 *
 * @example Apply migrations from a directory
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   migrations: "./migrations",
 * });
 * ```
 *
 * @example Drizzle migrations (drizzle-kit layout, detected automatically)
 * ```typescript
 * const schema = yield* Drizzle.Schema("app-schema", {
 *   schema: "./src/schema.ts",
 *   dialect: "sqlite",
 * });
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   migrations: schema,
 * });
 * ```
 *
 * @example Pin the format and table explicitly
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   migrations: {
 *     dir: "./migrations",
 *     format: "wrangler",
 *     table: "d1_migrations",
 *   },
 * });
 * ```
 *
 * @section Importing SQL
 * Use `importFiles` to seed the database with raw `.sql` files via Cloudflare's
 * D1 import API. Each file is hashed; only files whose contents change are
 * re-imported on subsequent deploys.
 *
 * @example Seed a database with SQL files
 * ```typescript
 * const db = yield* Cloudflare.D1.Database("my-db", {
 *   importFiles: ["./seed/users.sql", "./seed/posts.sql"],
 * });
 * ```
 *
 * @section Cloning a Database
 * `clone` performs a full export → import from a source database during
 * creation. It accepts a `D1Database` resource, a `{ databaseId }`, or a
 * `{ name }` to look up by name.
 *
 * @example Clone by passing the source resource directly
 * ```typescript
 * const source = yield* Cloudflare.D1.Database("source-db");
 * const cloned = yield* Cloudflare.D1.Database("cloned-db", {
 *   clone: source,
 * });
 * ```
 *
 * @example Clone by databaseId
 * ```typescript
 * const cloned = yield* Cloudflare.D1.Database("cloned-db", {
 *   clone: { databaseId: "abcdef12-3456-7890-abcd-ef1234567890" },
 * });
 * ```
 *
 * @example Clone by name
 * ```typescript
 * const cloned = yield* Cloudflare.D1.Database("cloned-db", {
 *   clone: { name: "source-db" },
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Using D1 inside a Worker
 * ```typescript
 * const db = yield* Cloudflare.D1.QueryDatabase(MyDatabase);
 *
 * // Run a query
 * const results = yield* db.prepare("SELECT * FROM users WHERE id = ?")
 *   .bind(userId)
 *   .all();
 *
 * // Execute a mutation
 * yield* db.prepare("INSERT INTO users (id, name) VALUES (?, ?)")
 *   .bind(newId, name)
 *   .run();
 * ```
 *
 * @see https://developers.cloudflare.com/d1/
 */
export const Database = Resource<Database>("Cloudflare.D1Database");

export const ProviderLive = () =>
  Provider.succeed(Database, {
    stables: ["databaseId", "accountId"],
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldName =
        output?.databaseName ?? (yield* createDatabaseName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      const oldJurisdiction =
        output?.jurisdiction ?? olds.jurisdiction ?? "default";
      if (
        oldName !== name ||
        oldJurisdiction !== (news.jurisdiction ?? "default") ||
        (olds.primaryLocationHint !== news.primaryLocationHint &&
          news.primaryLocationHint !== undefined)
      ) {
        return { action: "replace" } as const;
      }
      const oldReplicationMode =
        output?.readReplication?.mode ??
        olds.readReplication?.mode ??
        "disabled";
      const newReplicationMode = news.readReplication?.mode ?? "disabled";
      if (oldReplicationMode !== newReplicationMode) {
        return { action: "update" } as const;
      }
      // Detect migration/import file drift.
      const migrationsInput = migrationsInputOf(news);
      if (migrationsInput) {
        const newHashes = yield* hashMigrations(migrationsInput.dir);
        const oldHashes = output?.migrationsHashes ?? {};
        if (!recordsEqual(newHashes, oldHashes)) {
          return { action: "update" } as const;
        }
        // Resolution also fails the plan when an explicit format
        // contradicts the stamped one — the providerMode doctrine.
        const resolved = yield* resolveMigrations({
          input: migrationsInput,
          stamped: stampedOf(output),
          dialect: "sqlite",
        });
        if (
          resolved.table !== (output?.migrationsTable ?? resolved.table) ||
          resolved.format !== (output?.migrationsFormat ?? resolved.format)
        ) {
          return { action: "update" } as const;
        }
      } else if (
        output?.migrationsHashes &&
        Object.keys(output.migrationsHashes).length > 0
      ) {
        // migrations was removed but state still tracks them: nothing
        // to do remotely (we never un-apply), but no diff needed either.
      }
      if (news.importFiles?.length) {
        const newHashes = yield* hashImports(news.importFiles, yield* rootDir);
        const oldHashes = output?.importHashes ?? {};
        if (!recordsEqual(newHashes, oldHashes)) {
          return { action: "update" } as const;
        }
      }
      return undefined;
    }),
    // Account-scoped collection — D1 databases live under an account and the
    // distilled `listDatabases` op paginates them. Hydrate each row into the
    // same Attributes shape `read`'s name-lookup branch returns.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* d1.listDatabases.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .filter(
                (db): db is (typeof page.result)[number] & { uuid: string } =>
                  db.uuid != null,
              )
              .map((db) => ({
                databaseId: db.uuid,
                databaseName: db.name ?? db.uuid,
                jurisdiction: (db.jurisdiction ?? "default") as Jurisdiction,
                readReplication: undefined,
                accountId,
                migrationsDir: undefined,
                migrationsTable: undefined,
                migrationsFormat: undefined,
                migrationsHashes: {},
                importHashes: {},
              })),
          ),
        ),
      );
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output?.databaseId) {
        return yield* d1
          .getDatabase({
            accountId: output.accountId,
            databaseId: output.databaseId,
          })
          .pipe(
            Effect.map((db) => ({
              databaseId: db.uuid ?? output.databaseId,
              databaseName: db.name ?? output.databaseName,
              jurisdiction: output.jurisdiction,
              // Distilled widened generated string enums to open unions.
              readReplication: (db.readReplication ?? undefined) as
                | { mode: "auto" | "disabled" }
                | undefined,
              accountId: output.accountId,
              migrationsDir: output.migrationsDir,
              migrationsTable: output.migrationsTable,
              migrationsFormat: output.migrationsFormat,
              migrationsHashes: output.migrationsHashes,
              importHashes: output.importHashes,
            })),
            Effect.catchTag("DatabaseNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      }
      const name = yield* createDatabaseName(id, olds?.name);
      const match = yield* d1.listDatabases.items({ accountId, name }).pipe(
        Stream.filter((db) => db.name === name),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
      );
      if (match) {
        return {
          databaseId: match.uuid!,
          databaseName: match.name ?? name,
          jurisdiction: (olds?.jurisdiction ?? "default") as Jurisdiction,
          readReplication: olds?.readReplication,
          accountId,
          migrationsDir: olds?.migrationsDir,
          migrationsTable: olds?.migrationsTable,
          migrationsFormat: undefined,
          migrationsHashes: {},
          importHashes: {},
        };
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createDatabaseName(id, news.name);
      const jurisdiction = news.jurisdiction ?? "default";
      const acct = output?.accountId ?? accountId;

      // Observe — re-fetch the cached database; fall back to a name
      // lookup so we recover from out-of-band deletes or partial
      // state-persistence failures (the create call may have written
      // the database but lost the result before persist).
      let observed:
        | {
            uuid?: string | null;
            name?: string | null;
            // Distilled widened generated string enums to open unions.
            readReplication?: { mode: string } | null;
          }
        | undefined;
      if (output?.databaseId) {
        observed = yield* d1
          .getDatabase({
            accountId: acct,
            databaseId: output.databaseId,
          })
          .pipe(
            Effect.catchTag("DatabaseNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      }
      if (!observed) {
        observed = yield* d1.listDatabases
          .items({ accountId: acct, name })
          .pipe(
            Stream.filter((db) => db.name === name),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );
      }

      // Ensure — create if missing. Cloudflare returns
      // `InvalidProperty` when a database with the same name already
      // exists; we tolerate the race by re-listing to find it.
      let databaseId: string;
      let databaseName: string;
      const isFirstCreation = !observed;
      if (!observed) {
        const db = yield* d1
          .createDatabase({
            accountId: acct,
            name,
            jurisdiction: jurisdiction !== "default" ? jurisdiction : undefined,
            primaryLocationHint: news.primaryLocationHint,
          })
          .pipe(
            Effect.catchTag("InvalidProperty", () =>
              Effect.gen(function* () {
                const match = yield* d1.listDatabases
                  .items({ accountId: acct, name })
                  .pipe(
                    Stream.filter((db) => db.name === name),
                    Stream.runHead,
                    Effect.map(Option.getOrUndefined),
                  );
                if (match) {
                  return match;
                }
                return yield* Effect.die(
                  `Database with name "${name}" already exists but could not be found`,
                );
              }),
            ),
          );
        databaseId = db.uuid!;
        databaseName = db.name ?? name;
      } else {
        databaseId = observed.uuid ?? output!.databaseId;
        databaseName = observed.name ?? name;
      }

      // Sync read replication — the only mutable property on the
      // database resource itself. Always patch with the desired mode
      // so adoption converges drifted state.
      const desiredReplicationMode = news.readReplication?.mode ?? "disabled";
      const observedReplicationMode =
        observed?.readReplication?.mode ?? "disabled";
      if (
        isFirstCreation
          ? desiredReplicationMode !== "disabled"
          : observedReplicationMode !== desiredReplicationMode
      ) {
        const updated = yield* d1.patchDatabase({
          accountId: acct,
          databaseId,
          readReplication: { mode: desiredReplicationMode },
        });
        databaseId = updated.uuid ?? databaseId;
        databaseName = updated.name ?? databaseName;
      }

      // Clone is a one-shot seed performed only on first creation.
      // Re-running it on an existing database would clobber data.
      if (isFirstCreation && news.clone) {
        const sourceId = yield* resolveCloneSource(news.clone, acct);
        yield* cloneDatabase({
          accountId: acct,
          sourceDatabaseId: sourceId,
          targetDatabaseId: databaseId,
        });
      }

      // Sync migrations — the registry flow is idempotent (each format
      // skips already-applied entries), so this works for both first
      // create and ongoing updates.
      const migrationsInput = migrationsInputOf(news);
      let resolvedMigrations: ResolvedMigrations | undefined;
      let migrationsHashes: Record<string, string>;
      if (migrationsInput) {
        migrationsHashes = yield* hashMigrations(migrationsInput.dir);
        resolvedMigrations = yield* resolveMigrations({
          input: migrationsInput,
          stamped: stampedOf(output),
          dialect: "sqlite",
        });
        if (Object.keys(migrationsHashes).length > 0) {
          const queryDb = yield* d1.queryDatabase;
          const executor = makeD1MigrationExecutor((sql) =>
            queryDb({ accountId: acct, databaseId, sql }),
          );
          yield* applyResolvedMigrations({
            resolved: resolvedMigrations,
            executor,
          });
        }
      } else {
        migrationsHashes = isFirstCreation
          ? {}
          : (output?.migrationsHashes ?? {});
      }

      // Sync imports — `runImports` skips files whose hash matches
      // previously-imported state. On first create the previous map
      // is empty so all listed files import.
      const importHashes = news.importFiles?.length
        ? yield* runImports(
            acct,
            databaseId,
            news.importFiles,
            yield* rootDir,
            output?.importHashes ?? {},
          )
        : {};

      return {
        databaseId,
        databaseName,
        jurisdiction: (output?.jurisdiction ?? jurisdiction) as Jurisdiction,
        readReplication: news.readReplication,
        accountId: acct,
        migrationsDir: migrationsInput?.dir,
        // When migrations are removed, keep the stamp (like the hashes) so
        // a later re-add resolves against the same bookkeeping table.
        migrationsTable: resolvedMigrations?.table ?? output?.migrationsTable,
        migrationsFormat:
          resolvedMigrations?.format ?? output?.migrationsFormat,
        migrationsHashes,
        importHashes,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* d1
        .deleteDatabase({
          accountId: output.accountId,
          databaseId: output.databaseId,
        })
        .pipe(Effect.catchTag("DatabaseNotFound", () => Effect.void));
    }),
  });

/**
 * Local (dev) provider — the database is purely virtual: a `dev:` id keyed
 * into the local workerd D1 simulator (DO SQLite under `.alchemy/local/d1`).
 * `toRuntimeBinding` lowers a `d1` binding whose id is `dev:`-prefixed onto
 * the local D1 service.
 *
 * Migrations ARE applied locally: reconcile boots an ephemeral gateway
 * workerd (see `LocalD1Gateway.ts`) and drives the same executor-agnostic
 * migration flow the live provider uses, against the simulator's storage.
 *
 * RPC-backed: under `alchemy dev` (an `RpcProviderProxy` in context) the
 * whole lifecycle runs in the Cloudflare sidecar process — where
 * `localRuntimeServices()` is real and shared with the Worker/Queue/
 * Container local providers — instead of in the user's process where that
 * layer is gated empty (the root cause of #1007). In-process runs (no
 * proxy: `sidecar: false` tests, a plain deploy deleting a local-mode row)
 * build the provider directly with the un-gated runtime from the `dual`
 * registration.
 */
export const ProviderLocal = () =>
  RpcProvider.effect(
    Database,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      // The local runtime services (workerd `Runtime`, binding plugins) and
      // the HTTP client are resolved once at layer build and closed over —
      // lifecycle effects run with the engine's call-time context, which
      // doesn't include them.
      const runtimeContext = yield* Effect.context<
        RuntimeServices | HttpClient.HttpClient
      >();

      return {
        stables: ["accountId"],
        diff: Effect.fn(function* ({ news = {}, output }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          if (!output?.databaseId) return { action: "update" } as const;
          if (!isResolved(news)) return undefined;
          if (output.accountId !== accountId) {
            return { action: "replace" } as const;
          }
          // Detect migration/import file drift — same rules as the live
          // provider.
          const migrationsInput = migrationsInputOf(news);
          if (migrationsInput) {
            const newHashes = yield* hashMigrations(migrationsInput.dir);
            if (!recordsEqual(newHashes, output.migrationsHashes ?? {})) {
              return { action: "update" } as const;
            }
            const resolved = yield* resolveMigrations({
              input: migrationsInput,
              stamped: stampedOf(output),
              dialect: "sqlite",
            });
            if (
              resolved.table !== (output.migrationsTable ?? resolved.table) ||
              resolved.format !== (output.migrationsFormat ?? resolved.format)
            ) {
              return { action: "update" } as const;
            }
          }
          if (news.importFiles?.length) {
            const newHashes = yield* hashImports(
              news.importFiles,
              yield* rootDir,
            );
            if (!recordsEqual(newHashes, output.importHashes ?? {})) {
              return { action: "update" } as const;
            }
          }
          // Fall through to the engine's default prop diff.
        }),
        read: Effect.fn(function* ({ output }) {
          // Purely virtual — the persisted state row is the source of truth.
          return output ?? undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const databaseId = output?.databaseId ?? generateLocalId();

          // Sync migrations — the registry flow is idempotent (each format
          // skips applied entries), driven through the ephemeral local
          // gateway so the SAME format/bookkeeping applies locally as in
          // the cloud.
          const migrationsInput = migrationsInputOf(news);
          let resolvedMigrations: ResolvedMigrations | undefined;
          let migrationsHashes: Record<string, string> = {};
          if (migrationsInput) {
            migrationsHashes = yield* hashMigrations(migrationsInput.dir);
            resolvedMigrations = yield* resolveMigrations({
              input: migrationsInput,
              stamped: stampedOf(output),
              dialect: "sqlite",
            });
            if (Object.keys(migrationsHashes).length > 0) {
              const resolved = resolvedMigrations;
              yield* withLocalD1Executor(databaseId, (executor) =>
                applyResolvedMigrations({
                  resolved,
                  executor: makeD1MigrationExecutor(executor),
                }),
              ).pipe(Effect.provideContext(runtimeContext));
            }
          } else {
            migrationsHashes = output?.migrationsHashes ?? {};
          }

          // Sync imports — locally an import file is just multi-statement
          // SQL, executed through the same gateway. Files whose hash matches
          // previously-imported state are skipped (mirroring `runImports`).
          const importHashes: Record<string, string> = {
            ...(output?.importHashes ?? {}),
          };
          if (news.importFiles?.length) {
            const importRootDir = yield* rootDir;
            const pending: Array<{ path: string; sql: string; hash: string }> =
              [];
            for (const filePath of news.importFiles) {
              const file = yield* readSqlFile(importRootDir, filePath);
              if (importHashes[filePath] === file.hash) continue;
              pending.push({ path: filePath, sql: file.sql, hash: file.hash });
            }
            if (pending.length > 0) {
              yield* withLocalD1Executor(databaseId, (executor) =>
                Effect.forEach(pending, (file) => executor(file.sql), {
                  discard: true,
                }),
              ).pipe(Effect.provideContext(runtimeContext));
              for (const file of pending) {
                importHashes[file.path] = file.hash;
              }
            }
          }

          return {
            databaseId,
            databaseName: yield* createDatabaseName(id, news.name),
            jurisdiction: (news.jurisdiction ?? "default") as Jurisdiction,
            readReplication: news.readReplication,
            accountId: output?.accountId ?? accountId,
            migrationsDir: migrationsInput?.dir,
            migrationsTable:
              resolvedMigrations?.table ?? output?.migrationsTable,
            migrationsFormat:
              resolvedMigrations?.format ?? output?.migrationsFormat,
            migrationsHashes,
            importHashes,
          };
        }),
        delete: Effect.fn(function* () {
          // The simulator's on-disk data is keyed by the dev id; dropping
          // the state row is enough — orphaned data is reclaimed with
          // `.alchemy`.
        }),
      };
    }),
  );

export const DatabaseProvider = () =>
  ProviderLayer.dual(Database, {
    // The local provider's reconcile boots an ephemeral workerd gateway to
    // apply migrations, so it needs the shared local runtime layer. Under
    // `alchemy dev` the provider is an RPC stub (this gated layer is empty
    // and unused) and the sidecar entry (`../Local.ts`) supplies the real
    // runtime; without the proxy the provider builds in-process and this
    // layer is real.
    local: () => ProviderLocal().pipe(Layer.provide(localRuntimeServices())),
    live: () => ProviderLive(),
  });

const createDatabaseName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

const rootDir = Effect.sync(() => process.cwd());

/**
 * Resolve a clone source spec into a concrete database UUID. Looks up by
 * name through `listDatabases` when only a name is provided.
 */
const resolveCloneSource = (source: CloneSource, accountId: string) =>
  Effect.gen(function* () {
    if ("databaseId" in source && source.databaseId) {
      // At lifecycle time, Output<string> attributes have resolved to strings.
      return source.databaseId as unknown as string;
    }
    if ("name" in source && source.name) {
      const name = source.name as unknown as string;
      const match = yield* d1.listDatabases.items({ accountId, name }).pipe(
        Stream.filter((db) => db.name === name),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
      );
      if (!match?.uuid) {
        return yield* Effect.die(
          `Source database "${name}" not found for cloning`,
        );
      }
      return match.uuid;
    }
    return yield* Effect.die(
      "Invalid clone source: must provide databaseId or name",
    );
  });

/**
 * Read each `importFiles` entry and run it through the D1 import flow,
 * skipping files whose hash matches the previously-imported hash.
 */
const runImports = (
  accountId: string,
  databaseId: string,
  importFiles: ReadonlyArray<string>,
  rootDir: string,
  previous: Record<string, string>,
) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = { ...previous };
    for (const filePath of importFiles) {
      const file = yield* readSqlFile(rootDir, filePath);
      if (previous[filePath] === file.hash) {
        hashes[filePath] = file.hash;
        continue;
      }
      yield* importD1Database({
        accountId,
        databaseId,
        sqlData: file.sql,
        filename: file.id,
      });
      hashes[filePath] = file.hash;
    }
    // Drop entries for files no longer listed.
    const tracked = new Set(importFiles);
    for (const key of Object.keys(hashes)) {
      if (!tracked.has(key)) delete hashes[key];
    }
    return hashes;
  });
