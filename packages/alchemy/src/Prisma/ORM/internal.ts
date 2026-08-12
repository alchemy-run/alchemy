// Shared scaffolding for the Prisma ORM (prisma-next) deploy-time resources.
// NOT exported from the ORM index — service-internal only.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { exec } from "../../Util/exec.ts";

/**
 * A structured failure from the `prisma-next` CLI.
 *
 * The CLI emits machine-readable JSON on stderr-free stdout (`--json`), and
 * failures carry a stable `code` (e.g. `CONFIG.FILE_NOT_FOUND`,
 * `CONTRACT.VERIFY_FAILED`) plus human guidance in `summary`/`fix`. Those
 * fields are surfaced verbatim so callers can match on `code` and users get
 * the CLI's own remediation text.
 */
export class PrismaNextError extends Data.TaggedError(
  "Prisma.PrismaNextError",
)<{
  /** Stable machine code reported by the CLI (e.g. `CONTRACT.VERIFY_FAILED`). */
  code?: string | undefined;
  message: string;
  /** The CLI's suggested remediation, when it reported one. */
  fix?: string | undefined;
  /** Extra structured detail from the CLI (e.g. host/port on connection errors). */
  meta?: Record<string, unknown> | undefined;
}> {}

/**
 * Connection-flavored failures worth retrying: a database that was
 * provisioned earlier in the same deploy may not be accepting connections
 * yet (eventual consistency), so `Prisma.Migrate` retries these briefly.
 */
export const isTransientDbError = (error: PrismaNextError): boolean => {
  const meta = error.meta ?? {};
  const metaCode = typeof meta.code === "string" ? meta.code : "";
  return (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ].includes(metaCode) || /connection|timeout|reachable/i.test(error.message)
  );
};

/**
 * Resolve the `prisma-next` CLI entrypoint shipped inside
 * `@prisma/orm-postgres` (the façade bundles the full CLI as
 * `./bin/prisma-next`), so the resources only need the one optional peer the
 * runtime already requires.
 */
export const resolvePrismaNextBin = Effect.gen(function* () {
  const path = yield* Path.Path;
  const url = yield* Effect.try({
    try: () => import.meta.resolve("@prisma/orm-postgres/bin/prisma-next"),
    catch: (cause) =>
      new PrismaNextError({
        message: `Failed to resolve @prisma/orm-postgres (is it installed?): ${cause}`,
      }),
  });
  const fileUrl = yield* Effect.try({
    try: () => new URL(url),
    catch: (cause) =>
      new PrismaNextError({
        message: `Failed to parse @prisma/orm-postgres bin URL: ${cause}`,
      }),
  });
  return yield* path.fromFileUrl(fileUrl).pipe(
    Effect.mapError(
      (cause) =>
        new PrismaNextError({
          message: `Failed to convert @prisma/orm-postgres bin URL to a path: ${cause}`,
        }),
    ),
  );
});

interface CliFailure {
  ok: false;
  code?: string;
  summary?: string;
  why?: string;
  fix?: string;
  meta?: Record<string, unknown>;
}

/**
 * Run a `prisma-next` subcommand with `--json --no-interactive` from `cwd`
 * (the directory containing `prisma-next.config.ts` — all config-relative
 * paths resolve against it, matching a user running the CLI in their
 * project) and parse the structured result.
 */
export const runPrismaNext = <T extends { ok: true }>(
  args: readonly string[],
  options: { readonly cwd: string },
): Effect.Effect<T, PrismaNextError, Path.Path | ChildProcessSpawner> =>
  Effect.gen(function* () {
    const bin = yield* resolvePrismaNextBin;
    const nodeExecPath = yield* Effect.sync(() => process.execPath);
    const result = yield* exec(
      ChildProcess.make(
        nodeExecPath,
        [bin, ...args, "--json", "--no-interactive"],
        {
          cwd: options.cwd,
          env: { PRISMA_NEXT_DISABLE_TELEMETRY: "1" },
          extendEnv: true,
        },
      ),
    ).pipe(
      // exec fully drains stdout/stderr and the exit code before returning,
      // so the process handle's scope can close right here.
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new PrismaNextError({
            message: `prisma-next ${args.join(" ")} failed to spawn: ${String(cause)}`,
          }),
      ),
    );

    // The CLI prints exactly one JSON document to stdout in --json mode;
    // scan to the first `{` in case a stray banner precedes it.
    const parsed = yield* Effect.sync((): T | CliFailure | undefined => {
      const jsonStart = result.stdout.indexOf("{");
      if (jsonStart < 0) return undefined;
      try {
        return JSON.parse(result.stdout.slice(jsonStart)) as T | CliFailure;
      } catch {
        return undefined;
      }
    });

    if (parsed && parsed.ok === true) {
      return parsed;
    }
    if (parsed && parsed.ok === false) {
      return yield* Effect.fail(
        new PrismaNextError({
          code: parsed.code,
          message: `prisma-next ${args.join(" ")} failed: ${parsed.summary ?? parsed.why ?? "unknown error"}`,
          fix: parsed.fix,
          meta: parsed.meta,
        }),
      );
    }
    return yield* Effect.fail(
      new PrismaNextError({
        message: `prisma-next ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`,
      }),
    );
  });

/** `prisma-next contract emit --json` result. */
export interface EmitResult {
  ok: true;
  /** Canonical hash of the emitted contract's storage shape — the contract identity the migration graph and DB marker track. */
  storageHash: string;
  executionHash: string;
  profileHash: string;
  outDir: string;
  files: { json: string; dts: string };
}

/** `prisma-next migration plan --json` result. */
export interface PlanResult {
  ok: true;
  noOp: boolean;
  from: string | null;
  to: string;
  /** cwd-relative directory of the written migration package (absent when `noOp`). */
  dir?: string;
  /** True when the plan wrote `placeholder(...)` sentinels that need a human decision. */
  pendingPlaceholders?: boolean;
  operations: Array<{ id: string; label: string; operationClass: string }>;
}

/** `prisma-next migrate --json` result. */
export interface MigrateResult {
  ok: true;
  migrationsApplied: number;
  migrationsTotal: number;
  /** The DB marker's contract hash after the run. */
  markerHash: string;
  applied: Array<{
    spaceId: string;
    dirName: string;
    migrationHash: string;
    from: string;
    to: string;
  }>;
}

/** `prisma-next migrate --show --json` result (read-only preview). */
export interface MigrateShowResult {
  ok: true;
  migrations: Array<{
    spaceId: string;
    dirName: string;
    migrationHash: string;
    from: string;
    to: string;
  }>;
}

/**
 * One on-disk migration package under `{migrationsDir}/app/`.
 *
 * `opsEmpty` distinguishes a fully-emitted package (`ops.json` holds the
 * rendered operations) from one still carrying unfilled `placeholder(...)`
 * closures — `migration plan` writes `ops.json` as `[]` until the user edits
 * `migration.ts` and self-emits it.
 */
export interface MigrationPackage {
  dirName: string;
  from: string | null;
  to: string;
  migrationHash: string;
  opsEmpty: boolean;
}

/**
 * Read every migration package in the app contract space, sorted by
 * directory name (timestamp-prefixed).
 */
export const readMigrationPackages = (migrationsDirAbs: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appDir = path.join(migrationsDirAbs, "app");
    const exists = yield* fs.exists(appDir);
    if (!exists) return [] as MigrationPackage[];
    const entries = (yield* fs.readDirectory(appDir)).sort();
    const packages: MigrationPackage[] = [];
    for (const dirName of entries) {
      const metaPath = path.join(appDir, dirName, "migration.json");
      const hasMeta = yield* fs.exists(metaPath);
      if (!hasMeta) continue;
      const meta = yield* fs.readFileString(metaPath).pipe(
        Effect.flatMap((text) =>
          Effect.try({
            try: () =>
              JSON.parse(text) as {
                from: string | null;
                to: string;
                migrationHash: string;
              },
            catch: (cause) =>
              new PrismaNextError({
                message: `Failed to parse ${metaPath}: ${cause}`,
              }),
          }),
        ),
      );
      const opsPath = path.join(appDir, dirName, "ops.json");
      const hasOps = yield* fs.exists(opsPath);
      const opsText = hasOps ? yield* fs.readFileString(opsPath) : "[]";
      packages.push({
        dirName,
        from: meta.from,
        to: meta.to,
        migrationHash: meta.migrationHash,
        opsEmpty: opsText.trim() === "[]" || opsText.trim() === "",
      });
    }
    return packages;
  });

/**
 * Resolve the head of the migration graph: the `to` hash no other package
 * plans *from*. Directory-name order breaks ties (branchy graphs from
 * merges); an empty graph has no head.
 */
export const resolveGraphHead = (
  packages: readonly MigrationPackage[],
): MigrationPackage | undefined => {
  const froms = new Set(
    packages.flatMap((pkg) => (pkg.from === null ? [] : [pkg.from])),
  );
  const heads = packages.filter((pkg) => !froms.has(pkg.to));
  return heads.at(-1);
};
