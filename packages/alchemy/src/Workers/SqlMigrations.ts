import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ALCHEMY_DEFAULT_TABLE } from "../SQL/Migrations/AlchemyFormat.ts";
import { MigrationError } from "../SQL/Migrations/Format.ts";
import {
  SqlMigrationsRuntime,
  type SqlMigrationSnapshot,
  type SqlMigrationsExport,
} from "./SqlMigrationsRuntime.ts";

/** A migrations directory, optionally with a custom bookkeeping table. */
export type SqlMigrationsInput =
  | string
  | {
      /** Directory relative to the directory where Alchemy runs. */
      readonly dir: string;
      /** Applied-migrations table. Defaults to `__alchemy_migrations`. */
      readonly table?: string;
    };

/** Capture files during construction; resolve only embedded records at runtime. */
export const captureSqlMigrations = Effect.fn("SqlMigrations.capture")(
  function* (
    input: SqlMigrationsInput,
    host:
      | {
          readonly export: (
            name: string,
            value: SqlMigrationsExport,
          ) => Effect.Effect<void>;
        }
      | undefined,
  ) {
    const { dir, table = ALCHEMY_DEFAULT_TABLE } =
      typeof input === "string" ? { dir: input } : input;
    const key = `alchemy:sql-migrations:${JSON.stringify([dir, table])}`;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      if (host === undefined) {
        return yield* Effect.die(
          new MigrationError({
            message:
              "SQL migration capture requires a hosting Worker during construction",
          }),
        );
      }
      const { readMigrationRecords } = yield* Effect.promise(
        () => import("../SQL/Migrations/Records.ts"),
      );
      const snapshot: SqlMigrationSnapshot = {
        _tag: "Cloudflare.SqlMigrations",
        table,
        records: yield* readMigrationRecords(dir).pipe(Effect.orDie),
      };
      yield* host.export(key, { kind: "sqlMigrations", snapshot });
      return snapshot;
    }
    const bundles = yield* Effect.serviceOption(SqlMigrationsRuntime);
    const snapshot = Option.isSome(bundles) ? bundles.value[key] : undefined;
    if (snapshot === undefined) {
      return yield* Effect.die(
        new MigrationError({
          message: `SQL migrations for ${dir} were not captured during construction. Call SqlMigrations in the outer Durable Object Effect.`,
        }),
      );
    }
    return snapshot;
  },
);
