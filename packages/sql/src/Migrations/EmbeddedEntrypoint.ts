/**
 * Supply embedded SQL migration records to a runtime entrypoint. Used by
 * the generated entries of every Durable Object host (Cloudflare, Celld).
 *
 * @internal
 */
import { makeEntrypointLayer } from "alchemy/Runtime";
import { Self } from "alchemy/Self";
import * as Layer from "effect/Layer";
import { SqlMigrationsRuntime, type SqlMigrationSnapshot } from "./Embedded.ts";

/** Supply the generated migration records to every entrypoint and object activation. */
export const withSqlMigrations = (
  entrypoint: unknown,
  migrations: Readonly<Record<string, SqlMigrationSnapshot>>,
) =>
  makeEntrypointLayer(Self, entrypoint).pipe(
    Layer.provideMerge(Layer.succeed(SqlMigrationsRuntime, migrations)),
  );
