import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { ChildProcess } from "effect/unstable/process";
import { exec } from "../../Util/exec.ts";
import { PlatformServices } from "../../Util/PlatformServices.ts";
import { MigrationError } from "./Format.ts";

export const PRISMA_DEFAULT_TABLE = "_prisma_migrations";

/**
 * Apply a Prisma-layout migrations directory by delegating to
 * `prisma migrate deploy`. Alchemy NEVER writes `_prisma_migrations` rows
 * itself — the table is undocumented internal surface, and Prisma's
 * failure protocol (a failed migration leaves `finished_at` NULL and blocks
 * further migrations until `migrate resolve`) is load-bearing for their
 * tooling. Delegation inherits all of it.
 *
 * Requires a reachable connection string, so this format never applies on
 * D1 — which loses nothing: Prisma's own D1 guidance emits wrangler-format
 * migration dirs applied through wrangler's table.
 *
 * The schema file is resolved as the sibling of the migrations directory
 * (`{dir}/../schema.prisma`), Prisma's standard project layout. The
 * connection string is passed via `DATABASE_URL`, the conventional
 * `env("DATABASE_URL")` datasource binding; a schema using a different env
 * var surfaces Prisma's own error verbatim.
 */
export const applyPrismaNative = (options: {
  dir: string;
  connectionUrl: Redacted.Redacted<string>;
  cwd?: string;
}): Effect.Effect<void, MigrationError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = options.cwd ?? (yield* Effect.sync(() => process.cwd()));
    const dir = path.resolve(cwd, options.dir);

    const schemaPath = path.join(path.dirname(dir), "schema.prisma");
    if (!(yield* orFalse(fs.exists(schemaPath)))) {
      return yield* new MigrationError({
        message:
          `Prisma-format migrations at ${options.dir} have no schema.prisma sibling ` +
          `(looked for ${schemaPath}). "prisma migrate deploy" needs the schema to ` +
          `locate its datasource.`,
      });
    }

    const prismaBin = path.join(cwd, "node_modules", ".bin", "prisma");
    if (!(yield* orFalse(fs.exists(prismaBin)))) {
      return yield* new MigrationError({
        message:
          `Prisma-format migrations require the "prisma" CLI, but ${prismaBin} does ` +
          `not exist. Install prisma as a dev dependency in your project.`,
      });
    }

    // The spawner is provided locally (self-selecting bun/node) so the
    // registry's requirements stay at FileSystem/Path for every caller
    // that never takes the prisma path.
    const result = yield* exec(
      ChildProcess.make(
        prismaBin,
        ["migrate", "deploy", "--schema", schemaPath],
        {
          cwd,
          env: { DATABASE_URL: Redacted.value(options.connectionUrl) },
          extendEnv: true,
        },
      ),
    ).pipe(
      Effect.scoped,
      Effect.provide(PlatformServices),
      Effect.mapError(
        (cause) =>
          new MigrationError({
            message: `prisma migrate deploy failed: ${String(cause)}`,
            cause,
          }),
      ),
    );
    if (result.exitCode !== 0) {
      return yield* new MigrationError({
        message: `prisma migrate deploy exited ${result.exitCode}:\n${result.stderr || result.stdout}`,
      });
    }
  });

const orFalse = <E, R>(effect: Effect.Effect<boolean, E, R>) =>
  effect.pipe(Effect.catch(() => Effect.succeed(false)));
