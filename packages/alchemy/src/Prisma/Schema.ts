import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
import * as crypto from "node:crypto";
import * as Artifacts from "../Artifacts.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { exec } from "../Util/exec.ts";
import type { Providers } from "./Providers.ts";

export type SchemaProps = {
  /**
   * Path to the Prisma schema file, relative to the current working
   * directory. The datasource `provider` declared in the schema selects the
   * SQL dialect (`postgresql`, `sqlite` for D1, `mysql` for PlanetScale).
   *
   * @example "./prisma/schema.prisma"
   */
  schema: string;
  /**
   * Output directory for generated migrations. Each migration is written as
   * `{out}/{timestamp}_migration/{migration.sql, snapshot.prisma}` — the same
   * layout `prisma migrate dev` produces, so `prisma migrate deploy` and
   * Alchemy's `migrationsDir` consumers (`Neon.Branch`,
   * `Cloudflare.D1.Database`, `Planetscale.PostgresBranch`, …) both apply
   * them unchanged.
   *
   * @default "./prisma/migrations"
   */
  out?: string;
  /**
   * Run `prisma generate` after regenerating migrations so the Prisma Client
   * stays in sync with the schema. Skipped automatically when the schema has
   * no `generator` block.
   *
   * @default true
   */
  generateClient?: boolean;
};

export type Schema = Resource<
  "Prisma.Schema",
  SchemaProps,
  {
    /** Path to the migrations directory, relative to the current working directory. */
    out: string;
    /**
     * sha256 of the latest snapshot.prisma. Stable across deploys when the
     * schema is unchanged; bumps trigger an update which regenerates pending
     * migration SQL. Downstream `migrationsDir` consumers read this to
     * detect drift and reapply.
     */
    snapshotHash: string;
    /** Names of all migration directories under `out`, in order. */
    migrations: string[];
  },
  never,
  Providers
>;

/**
 * A Prisma schema managed as an Alchemy resource.
 *
 * Wraps `prisma migrate diff` so migration SQL is regenerated as part of
 * `alchemy deploy` whenever `schema.prisma` changes — no shadow database and
 * no interactive `prisma migrate dev` step. Each migration directory stores a
 * `snapshot.prisma` alongside the SQL; the next deploy diffs the live schema
 * against that snapshot, entirely offline. The output directory is intended
 * to be passed straight to a database resource's `migrationsDir`, giving you
 * a single deploy-driven flow:
 *
 * ```typescript
 * const schema = yield* Prisma.Schema("app-schema", {
 *   schema: "./prisma/schema.prisma",
 * });
 *
 * const branch = yield* Neon.Branch("app-branch", {
 *   project,
 *   migrationsDir: schema.out,
 * });
 * ```
 *
 * `Prisma.Schema` runs first (because `Neon.Branch` depends on its `out`
 * output), regenerates pending migration files, and `Neon.Branch` then
 * applies them transactionally. With a `sqlite` datasource the same wiring
 * targets `Cloudflare.D1.Database`, and with `mysql` it targets
 * `Planetscale.MySQLBranch`.
 *
 * Adopting an existing Prisma project (migrations created by `prisma migrate
 * dev`, so no snapshots yet) is safe: the first deploy records the current
 * schema as the baseline instead of re-emitting SQL for tables your existing
 * migrations already create.
 *
 * The resource is delete-safe: removing it from the stack does **not** wipe
 * the migrations directory, since migration files are typically checked in
 * and shared with other environments.
 * @resource
 */
export const Schema = Resource<Schema>("Prisma.Schema");

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const tsStamp = () =>
  new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

const SNAPSHOT_FILE = "snapshot.prisma";

/** Written by `prisma migrate diff -o` when the diff is empty. */
const EMPTY_MIGRATION = "-- This is an empty migration.";

/**
 * The Prisma 7 schema engine refuses to start without a datasource, even for
 * pure datamodel↔datamodel diffs that never touch a database. A throwaway
 * config with a placeholder URL satisfies it; no connection is ever opened.
 */
const DUMMY_CONFIG = `export default {
  datasource: {
    url: "postgresql://user:pass@localhost:5432/db",
  },
};
`;

export const SchemaProvider = () =>
  Provider.effect(
    Schema,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const resolveOut = (p: SchemaProps) =>
        path.resolve(process.cwd(), p.out ?? "./prisma/migrations");

      // The `out` attribute is exposed as a path relative to the current
      // working directory so that persisted state stays portable across
      // machines/checkouts. Internal filesystem ops always use the absolute
      // `resolveOut` form.
      const relativeOut = (abs: string) => path.relative(process.cwd(), abs);

      const resolveSchema = (p: SchemaProps) =>
        path.resolve(process.cwd(), p.schema);

      const prismaBin = Effect.gen(function* () {
        const url = yield* Effect.try({
          // The CLI entry — the package's root export is its config types.
          try: () => import.meta.resolve("prisma/build/index.js"),
          catch: (cause) =>
            new Error(
              `Failed to resolve prisma (is prisma installed?): ${cause}`,
            ),
        });
        const fileUrl = yield* Effect.try({
          try: () => new URL(url),
          catch: (cause) => new Error(`Failed to parse prisma URL: ${cause}`),
        });
        return yield* path.fromFileUrl(fileUrl);
      });

      const runPrisma = (args: string[]) =>
        Effect.gen(function* () {
          const bin = yield* prismaBin;
          const nodeExecPath = yield* Effect.sync(() => process.execPath);
          const result = yield* exec(
            ChildProcess.make(nodeExecPath, [bin, ...args], {
              cwd: process.cwd(),
              extendEnv: true,
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new Error(`prisma ${args[0]} failed: ${String(cause)}`),
            ),
          );
          return result;
        });

      const listMigrationDirs = (out: string) =>
        Effect.gen(function* () {
          const exists = yield* fs.exists(out);
          if (!exists) return [] as string[];
          const entries = yield* fs.readDirectory(out);
          const dirs: string[] = [];
          for (const name of entries.filter((n) => /^\d+_/.test(n)).sort()) {
            const stat = yield* fs.stat(path.join(out, name));
            if (stat.type === "Directory") dirs.push(name);
          }
          return dirs;
        });

      const readLatestSnapshot = (out: string) =>
        Effect.gen(function* () {
          const dirs = yield* listMigrationDirs(out);
          for (const dir of [...dirs].reverse()) {
            const snapshotPath = path.join(out, dir, SNAPSHOT_FILE);
            const exists = yield* fs.exists(snapshotPath);
            if (!exists) continue;
            const text = yield* fs.readFileString(snapshotPath);
            return { path: snapshotPath, hash: sha(text) };
          }
          return undefined;
        });

      /**
       * Diff `from` (a schema file path, or undefined for an empty database)
       * against the current schema, entirely offline via `prisma migrate
       * diff`. Returns the migration SQL, or undefined when the schemas are
       * equivalent.
       *
       * The Prisma CLI swallows schema-engine startup crashes as a silent
       * exit 0, so success is judged by the `-o` file: the engine writes it
       * even for an empty diff (`-- This is an empty migration.`), meaning a
       * missing file is always an engine failure.
       */
      const diffSchemas = (from: string | undefined, to: string) =>
        Effect.gen(function* () {
          const tmp = yield* fs.makeTempDirectory({
            prefix: "alchemy-prisma-diff-",
          });
          return yield* Effect.gen(function* () {
            const configPath = path.join(tmp, "prisma.config.ts");
            yield* fs.writeFileString(configPath, DUMMY_CONFIG);
            const outFile = path.join(tmp, "diff.sql");

            const result = yield* runPrisma([
              "migrate",
              "diff",
              "--config",
              configPath,
              ...(from ? ["--from-schema", from] : ["--from-empty"]),
              "--to-schema",
              to,
              "--script",
              "-o",
              outFile,
            ]);

            const wrote = yield* fs.exists(outFile);
            if (result.exitCode !== 0 || !wrote) {
              return yield* Effect.fail(
                new Error(
                  `prisma migrate diff failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`,
                ),
              );
            }
            const sql = yield* fs.readFileString(outFile);
            return sql.trim() === EMPTY_MIGRATION ? undefined : sql;
          }).pipe(
            Effect.ensuring(
              fs.remove(tmp, { recursive: true }).pipe(Effect.ignore),
            ),
          );
        });

      /**
       * Compare the current schema against the latest stored snapshot and
       * return the pending migration SQL (if any). Used by both `diff` (to
       * decide whether the resource actually needs an update) and
       * `regenerate` (to decide whether to write a new migration dir).
       *
       * When migrations exist but none carries a snapshot (a project
       * previously managed by `prisma migrate dev`), the current schema is
       * treated as the baseline: existing migrations are assumed to already
       * express it, so no SQL is emitted — only a snapshot is recorded.
       */
      const detectDrift = (props: SchemaProps) =>
        Effect.gen(function* () {
          const out = resolveOut(props);
          const schemaPath = resolveSchema(props);
          const prev = yield* readLatestSnapshot(out);
          const dirs = yield* listMigrationDirs(out);

          if (prev === undefined && dirs.length > 0) {
            return { out, schemaPath, sql: undefined, baseline: true as const };
          }

          const sql = yield* diffSchemas(prev?.path, schemaPath);
          return { out, schemaPath, sql, baseline: false as const };
        }).pipe(Artifacts.cached("detectDrift"));

      const datasourceProvider = (schemaText: string) =>
        schemaText.match(
          /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/,
        )?.[1];

      /**
       * `prisma migrate deploy` refuses to run without a lock file, so keep
       * one in place for anyone applying these migrations with the Prisma
       * CLI instead of a `migrationsDir` consumer.
       */
      const ensureMigrationLock = (out: string, schemaText: string) =>
        Effect.gen(function* () {
          const lockPath = path.join(out, "migration_lock.toml");
          const exists = yield* fs.exists(lockPath);
          if (exists) return;
          const provider = datasourceProvider(schemaText) ?? "postgresql";
          yield* fs.writeFileString(
            lockPath,
            `# Please do not edit this file manually\n# It should be added in your version-control system (e.g., Git)\nprovider = "${provider}"\n`,
          );
        });

      const generateClient = (props: SchemaProps, schemaText: string) =>
        Effect.gen(function* () {
          if (props.generateClient === false) return;
          // `prisma generate` errors on a schema with no generator block;
          // treat that as "nothing to generate" rather than a deploy failure.
          if (!/generator\s+\w+\s*\{/.test(schemaText)) return;
          const result = yield* runPrisma([
            "generate",
            "--schema",
            resolveSchema(props),
          ]);
          if (result.exitCode !== 0) {
            return yield* Effect.fail(
              new Error(
                `prisma generate failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`,
              ),
            );
          }
        });

      /**
       * Generate a new migration directory if the schema has drifted from
       * the latest snapshot. Returns the new state regardless.
       */
      const regenerate = (props: SchemaProps) =>
        Effect.gen(function* () {
          const drift = yield* detectDrift(props);
          const { out, schemaPath } = drift;
          const schemaText = yield* fs.readFileString(schemaPath);

          if (drift.baseline) {
            // Existing prisma-migrate-dev project: record the current schema
            // as the baseline snapshot inside the latest migration dir.
            const dirs = yield* listMigrationDirs(out);
            const latest = dirs[dirs.length - 1];
            yield* fs.writeFileString(
              path.join(out, latest, SNAPSHOT_FILE),
              schemaText,
            );
          } else if (drift.sql !== undefined) {
            const dirName = `${tsStamp()}_migration`;
            const dirPath = path.join(out, dirName);
            yield* fs.makeDirectory(dirPath, { recursive: true });
            yield* fs.writeFileString(
              path.join(dirPath, "migration.sql"),
              drift.sql,
            );
            yield* fs.writeFileString(
              path.join(dirPath, SNAPSHOT_FILE),
              schemaText,
            );
          }

          const outExists = yield* fs.exists(out);
          if (outExists) {
            yield* ensureMigrationLock(out, schemaText);
          }

          yield* generateClient(props, schemaText);

          const migrations = yield* listMigrationDirs(out);
          const latest = yield* readLatestSnapshot(out);
          const snapshotHash = latest?.hash ?? sha(schemaText);
          return {
            out: relativeOut(out),
            snapshotHash,
            migrations,
          };
        });

      return {
        // Non-listable: a Prisma.Schema is a local build artifact (generated
        // migration SQL under `out`, a path supplied entirely by props with no
        // account/store to enumerate). There is no remote enumeration API, so
        // there is nothing to discover out-of-band.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          // Only flag an update when prisma would emit new SQL (or an
          // adopted project needs its baseline snapshot recorded) —
          // otherwise downstream resources (e.g. Neon.Branch) would see
          // `schema.out` as an unresolved Output during plan and cascade
          // into spurious updates of their own.
          const drift = yield* detectDrift(news);
          const changed = drift.baseline || drift.sql !== undefined;
          return changed || output.out !== relativeOut(resolveOut(news))
            ? { action: "update" }
            : undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (!output) return undefined;
          const out = resolveOut(olds ?? ({} as SchemaProps));
          const exists = yield* fs.exists(out);
          if (!exists) return undefined;
          const latest = yield* readLatestSnapshot(out);
          const migrations = yield* listMigrationDirs(out);
          return {
            out: relativeOut(out),
            snapshotHash: latest?.hash ?? output.snapshotHash,
            migrations,
          };
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          yield* session.note(
            `${output ? "Regenerating" : "Generating"} prisma migrations for ${news.schema}`,
          );
          return yield* regenerate(news);
        }),
        delete: Effect.fn(function* () {
          // Migrations are typically checked in; do not delete on resource
          // teardown.
        }),
      };
    }),
  );
