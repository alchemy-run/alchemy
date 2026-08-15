import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { ALCHEMY_DEFAULT_TABLE, applyAlchemyFormat } from "./AlchemyFormat.ts";
import { detectLayout, formatForLayout } from "./Detect.ts";
import {
  applyDrizzleFormat,
  DRIZZLE_DEFAULT_PG_SCHEMA,
  DRIZZLE_DEFAULT_TABLE,
} from "./DrizzleFormat.ts";
import {
  MigrationError,
  MigrationFormatMismatchError,
  MigrationFormatUnsupportedError,
  type DrizzleV0LayoutError,
  type MigrationDialect,
  type MigrationFormatTag,
  type MigrationHistoryConflictError,
  type SqlExecutor,
} from "./Format.ts";
import { applyPrismaNative, PRISMA_DEFAULT_TABLE } from "./PrismaFormat.ts";
import { readDrizzleDirRecords, readFlatRecords } from "./Records.ts";
import {
  applyWranglerFormat,
  WRANGLER_DEFAULT_TABLE,
} from "./WranglerFormat.ts";

/**
 * The migrations input surface shared by every SQL database resource.
 * A plain string is a directory whose format is detected from its layout;
 * the object form pins the format/table explicitly. A `Drizzle.Schema`
 * resource's attributes satisfy the `{ out, format }` shape structurally,
 * so `migrations: schema` works without importing the Drizzle module.
 */
export type MigrationsInput =
  | string
  | {
      /** Directory containing the migration files. */
      dir: string;
      /**
       * Bookkeeping format. Defaults to layout detection (Prisma's
       * `migration_lock.toml`, drizzle-v1's `snapshot.json` dirs), falling
       * back to the target's default for flat `.sql` directories.
       */
      format?: MigrationFormatTag;
      /** Override the applied-migrations table name. */
      table?: string;
      /** Postgres only: the schema holding the migrations table. */
      schema?: string;
    }
  | {
      /** A `Drizzle.Schema`-shaped resource output. */
      out: string;
      format?: MigrationFormatTag;
    };

export interface NormalizedMigrationsInput {
  dir: string;
  format?: MigrationFormatTag;
  table?: string;
  schema?: string;
}

export const normalizeMigrationsInput = (
  input: MigrationsInput,
): NormalizedMigrationsInput => {
  if (typeof input === "string") return { dir: input };
  if ("out" in input) return { dir: input.out, format: input.format };
  return input;
};

/**
 * What the resource's persisted state remembers about prior migration runs.
 * `table`/`format` come from prior attrs; `hasHistory` is true when the
 * state carries applied-migration hashes from any earlier deploy.
 */
export interface StampedMigrationsState {
  format?: MigrationFormatTag | undefined;
  table?: string | undefined;
  hasHistory: boolean;
}

export interface ResolvedMigrations {
  dir: string;
  format: MigrationFormatTag;
  table: string;
  /** Postgres only; set for formats that schema-qualify their table. */
  schema: string | undefined;
}

/**
 * Normalize a resource's `migrations` prop (or its deprecated
 * `migrationsDir`/`migrationsTable` pair) into the registry input shape.
 * Shared by every SQL database resource.
 */
export const migrationsInputOf = (props: {
  migrations?: MigrationsInput;
  migrationsDir?: string;
  migrationsTable?: string;
}): NormalizedMigrationsInput | undefined =>
  props.migrations
    ? normalizeMigrationsInput(props.migrations)
    : props.migrationsDir
      ? { dir: props.migrationsDir, table: props.migrationsTable }
      : undefined;

/**
 * Derive the stamped-state view from a resource's prior attributes.
 * Unstamped rows with history were written by a pre-registry Alchemy and
 * resolve to the legacy format (see {@link resolveMigrations}).
 */
export const stampedOf = (
  output:
    | {
        migrationsFormat?: MigrationFormatTag | undefined;
        migrationsTable: string | undefined;
        migrationsHashes: Record<string, string>;
      }
    | undefined,
): StampedMigrationsState => ({
  format: output?.migrationsFormat,
  table: output?.migrationsTable,
  hasHistory:
    output !== undefined &&
    (output.migrationsTable !== undefined ||
      Object.keys(output.migrationsHashes ?? {}).length > 0),
});

export const defaultTableForFormat = (format: MigrationFormatTag): string => {
  switch (format) {
    case "drizzle":
      return DRIZZLE_DEFAULT_TABLE;
    case "prisma":
      return PRISMA_DEFAULT_TABLE;
    case "wrangler":
      return WRANGLER_DEFAULT_TABLE;
    case "alchemy":
      return ALCHEMY_DEFAULT_TABLE;
  }
};

/**
 * Resolve which format governs this deploy. Precedence:
 *
 * 1. An explicit `format` on the input — checked against the stamp; a
 *    contradiction fails the plan rather than starting a second bookkeeping
 *    table beside the first (the `providerMode` doctrine).
 * 2. The format stamped in state by a prior deploy.
 * 3. Legacy inference: state has migration history but no stamp — written by
 *    a pre-registry Alchemy, whose invented table shape is upgraded in
 *    place. On sqlite the legacy default table was already `d1_migrations`,
 *    so legacy rows resolve to `wrangler`; elsewhere to `alchemy`. Layout
 *    detection is deliberately skipped here: a drizzle-layout dir whose
 *    history lives in the legacy table must keep converging against that
 *    table, not start over in `__drizzle_migrations`.
 * 4. Layout detection on the directory (fresh state only).
 */
export const resolveMigrations = (options: {
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
  dialect: MigrationDialect;
}): Effect.Effect<
  ResolvedMigrations,
  MigrationFormatMismatchError | DrizzleV0LayoutError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const { input, stamped, dialect } = options;

    const stampedFormat =
      stamped.format ??
      (stamped.hasHistory
        ? dialect === "sqlite"
          ? ("wrangler" as const)
          : ("alchemy" as const)
        : undefined);

    let format: MigrationFormatTag;
    if (input.format) {
      if (stampedFormat && stampedFormat !== input.format) {
        return yield* new MigrationFormatMismatchError({
          stamped: stampedFormat,
          requested: input.format,
          message:
            `Migration state for this resource was written in the "${stampedFormat}" ` +
            `format, but the resource now requests "${input.format}". Switching formats ` +
            `would start a second bookkeeping table and replay applied migrations. ` +
            `Keep format: "${stampedFormat}", or migrate the bookkeeping table manually ` +
            `and update the resource state.`,
        });
      }
      format = input.format;
    } else if (stampedFormat) {
      format = stampedFormat;
    } else {
      format = formatForLayout(yield* detectLayout(input.dir), dialect);
    }

    const table = input.table ?? stamped.table ?? defaultTableForFormat(format);
    const schema =
      input.schema ??
      (format === "drizzle" && dialect === "postgres"
        ? DRIZZLE_DEFAULT_PG_SCHEMA
        : undefined);
    return { dir: input.dir, format, table, schema };
  });

/**
 * Apply pending migrations under the resolved format. Inline formats
 * (`drizzle`/`wrangler`/`alchemy`) require an `executor`; the `prisma`
 * format ignores it and instead needs `connectionUrl` — its bookkeeping is
 * only ever written by `prisma migrate deploy`.
 */
export const applyMigrations = (options: {
  resolved: ResolvedMigrations;
  executor?: SqlExecutor;
  connectionUrl?: Redacted.Redacted<string>;
  cwd?: string;
}): Effect.Effect<
  void,
  | MigrationError
  | MigrationFormatUnsupportedError
  | MigrationHistoryConflictError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const { resolved } = options;
    if (resolved.format !== "prisma" && !options.executor) {
      return yield* new MigrationError({
        message: `The "${resolved.format}" migration format requires a SQL executor.`,
      });
    }
    const executor = options.executor!;
    switch (resolved.format) {
      case "drizzle":
        return yield* applyDrizzleFormat({
          executor,
          dir: resolved.dir,
          table: resolved.table,
          schema: resolved.schema,
        });
      case "wrangler": {
        if (executor.dialect !== "sqlite") {
          return yield* new MigrationFormatUnsupportedError({
            format: "wrangler",
            message: `The "wrangler" migration format is sqlite-only (it is wrangler's d1_migrations table); this target speaks ${executor.dialect}.`,
          });
        }
        const records = yield* readFlatRecords(resolved.dir);
        return yield* applyWranglerFormat({
          executor,
          table: resolved.table,
          records,
        });
      }
      case "alchemy": {
        const layout = yield* detectLayout(resolved.dir).pipe(
          Effect.catchTag("DrizzleV0LayoutError", (error) =>
            Effect.fail(
              new MigrationFormatUnsupportedError({
                format: "alchemy",
                message: error.message,
              }),
            ),
          ),
        );
        const records =
          layout === "drizzle"
            ? yield* readDrizzleDirRecords(resolved.dir)
            : yield* readFlatRecords(resolved.dir);
        return yield* applyAlchemyFormat({
          executor,
          table: resolved.table,
          records,
        });
      }
      case "prisma": {
        if (!options.connectionUrl) {
          return yield* new MigrationFormatUnsupportedError({
            format: "prisma",
            message:
              `Prisma-format migrations are applied via "prisma migrate deploy", which ` +
              `needs a connection string this target cannot provide. On D1, follow ` +
              `Prisma's D1 guidance: generate SQL with "prisma migrate diff" into a ` +
              `flat migrations directory (wrangler format).`,
          });
        }
        return yield* applyPrismaNative({
          dir: resolved.dir,
          connectionUrl: options.connectionUrl,
          cwd: options.cwd,
        });
      }
    }
  });
