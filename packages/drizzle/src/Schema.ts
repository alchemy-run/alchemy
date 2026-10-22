import * as crypto from "node:crypto";
import * as Artifacts from "alchemy/Artifacts";
import { isResolved } from "alchemy/Diff";
import { Interaction } from "alchemy/Interaction";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import type { Providers } from "./Providers.ts";

export type Dialect = "postgres" | "mysql" | "sqlite";

type DdlEntry = {
  readonly entityType: string;
  readonly schema?: string;
  readonly table?: string;
  readonly name?: string;
  readonly [field: string]: unknown;
};

// A `snapshot.json`. Postgres folders hold one `base` snapshot followed by
// `diff` snapshots carrying `deltas`; mysql and sqlite snapshots are full.
type Snapshot = {
  readonly type?: "base" | "diff";
  readonly version?: string;
  readonly dialect?: string;
  readonly id?: string;
  readonly prevIds?: ReadonlyArray<string>;
  readonly ddl?: ReadonlyArray<DdlEntry>;
};

// drizzle-kit's `MissingHint` / `Hint`, narrowed to what `generate` can ask:
// rename-or-create. Its `confirm_data_loss` questions need a live database
// (`push` checks whether tables are empty), so generate never raises them.
// Entity ids are tuples: `[name]`, `[schema, name]` or `[schema, table, name]`.
type MissingHint = {
  readonly type: "rename_or_create";
  readonly kind: string;
  readonly entity: ReadonlyArray<string>;
};

type Hint =
  | { type: "rename"; kind: string; from: ReadonlyArray<string>; to: ReadonlyArray<string> }
  | { type: "create"; kind: string; entity: ReadonlyArray<string> };

type GenerateResult =
  | { status: "ok"; statements?: ReadonlyArray<unknown> }
  | { status: "no_changes" }
  | { status: "missing_hints"; unresolved: ReadonlyArray<MissingHint> }
  | { status: "error"; error: unknown };

// `drizzle-kit/cli`: the `drizzle-kit` commands as functions. They never
// prompt and report results (including unanswered questions) as values.
type DrizzleKitCli = {
  generate: (options: {
    dialect: string;
    schema: string;
    out: string;
    explain?: boolean;
    hints?: Array<Hint>;
  }) => Promise<GenerateResult>;
  up: (options: { dialect: string; out: string }) => Promise<GenerateResult>;
};

// `drizzle-kit/payload/*`: snapshot builders. Only postgres has `reconstruct`.
type DrizzleKitPayload = {
  generateDrizzleJson: (imports: Record<string, unknown>) => Promise<Snapshot>;
  reconstruct?: (files: Record<string, Snapshot>, id?: string) => Promise<Snapshot>;
};

class DrizzleKitLoadFailed extends Data.TaggedError("DrizzleKitLoadFailed")<{
  readonly module: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Failed to load ${this.module} (is drizzle-kit installed?): ${this.cause}`;
  }
}

class SchemaImportFailed extends Data.TaggedError("SchemaImportFailed")<{
  readonly schema: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Failed to import schema at ${this.schema}: ${this.cause}`;
  }
}

class DrizzleKitFailed extends Data.TaggedError("DrizzleKitFailed")<{
  readonly command: string;
  readonly cause: unknown;
}> {
  override get message() {
    const { cause } = this;
    const detail = Predicate.hasProperty(cause, "humanMessage")
      ? cause.humanMessage
      : cause instanceof Error
        ? cause.message
        : JSON.stringify(cause);
    return `drizzle-kit ${this.command} failed: ${detail}`;
  }
}

/** A legacy postgres snapshot chain that could not be converted faithfully. */
class SnapshotConversionFailed extends Data.TaggedError("SnapshotConversionFailed")<{
  readonly folder: string;
}> {
  override get message() {
    return `Could not convert ${this.folder}/snapshot.json to drizzle-kit's incremental snapshot format. Regenerate the migrations folder with drizzle-kit.`;
  }
}

/** An ambiguous schema change with no terminal to ask. */
class UndecidedSchemaChange extends Data.TaggedError("UndecidedSchemaChange")<{
  readonly props: SchemaProps;
  readonly hint: MissingHint;
}> {
  override get message() {
    const { props, hint } = this;
    return [
      `drizzle-kit needs a decision for ${props.schema} that cannot be made non-interactively:`,
      `  ${hint.kind} ${formatEntity(hint.entity)}: created or renamed?`,
      "",
      "Re-run the deploy in an interactive terminal to answer it, or generate the migration yourself and commit it:",
      `  npx drizzle-kit generate --dialect ${cliDialect(props)} --schema ${props.schema} --out ${props.out ?? "./migrations"}`,
    ].join("\n");
  }
}

export type SchemaProps = {
  /**
   * Path to the schema module, relative to the current working directory.
   * The module is loaded via dynamic `import()` so drizzle-kit can introspect
   * the table definitions, then diffed against the latest snapshot under
   * `out` to detect changes.
   *
   * @example "./src/schema.ts"
   */
  schema: string;
  /**
   * Output directory for generated migrations, in drizzle-kit's own layout:
   * `{out}/{timestamp}_{name}/{migration.sql, snapshot.json}`. Pass this
   * through as a database resource's `migrations` prop (`Neon.Branch`,
   * `Fly.Postgres`, `Cloudflare.D1.Database`, …) to apply pending
   * migrations on deploy.
   *
   * @default "./migrations"
   */
  out?: string;
  /**
   * SQL dialect to generate migrations for.
   *
   * @default "postgres"
   */
  dialect?: Dialect;
};

export type Schema = Resource<
  "Drizzle.Schema",
  SchemaProps,
  {
    /** Path to the migrations directory, relative to the current working directory. */
    out: string;
    /**
     * sha256 of the latest snapshot.json. Stable across deploys when the
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
 * A Drizzle schema managed as an Alchemy resource.
 *
 * Runs `drizzle-kit generate` through drizzle-kit's programmatic API so
 * migration SQL is regenerated as part of `alchemy deploy` whenever the
 * source schema changes. Ambiguous changes (a rename or a new column/table?)
 * are asked with Alchemy's prompts during plan. The output directory is
 * intended to be passed straight to a database resource's `migrations`
 * prop, giving you a single deploy-driven flow:
 *
 * ```typescript
 * const schema = yield* Drizzle.Schema("app-schema", {
 *   schema: "./src/schema.ts",
 * });
 *
 * const branch = yield* Neon.Branch("app-branch", {
 *   project,
 *   migrations: schema,
 * });
 *
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 *   migrations: schema,
 * });
 * ```
 *
 * `Drizzle.Schema` runs first (because the database resource depends
 * on its `out` output), regenerates pending migration files, and the
 * database resource then applies them.
 *
 * The resource is delete-safe: removing it from the stack does **not** wipe
 * the migrations directory, since migration files are typically checked in
 * and shared with other environments.
 *
 * @resource
 */
export const Schema = Resource<Schema>("Drizzle.Schema");

const ORIGIN = "00000000-0000-0000-0000-000000000000";

const cliDialect = (props: SchemaProps) =>
  props.dialect === undefined || props.dialect === "postgres" ? "postgresql" : props.dialect;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const importModule = <A>(module: string) =>
  Effect.tryPromise({
    try: () => import(/* @vite-ignore */ module) as Promise<A>,
    catch: (cause) => new DrizzleKitLoadFailed({ module, cause }),
  });

export const SchemaProvider = () =>
  Provider.effect(
    Schema,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const resolveOut = (p: SchemaProps) => path.resolve(process.cwd(), p.out ?? "./migrations");

      // The `out` attribute is exposed as a path relative to the current
      // working directory so that persisted state stays portable across
      // machines/checkouts. Internal filesystem ops always use the absolute
      // `resolveOut` form.
      const relativeOut = (abs: string) => path.relative(process.cwd(), abs);

      const resolveSchema = (p: SchemaProps) => path.resolve(process.cwd(), p.schema);

      // List `<ts>_*` migration directories under `out`, sorted by numeric
      // prefix. Returns an empty array if `out` doesn't exist.
      const listMigrationDirs = Effect.fn("Drizzle.listMigrationDirs")(function* (out: string) {
        if (!(yield* fs.exists(out))) return [];
        const entries = yield* fs.readDirectory(out);
        return entries.filter((name) => /^\d+_/.test(name)).sort();
      });

      const readSnapshots = Effect.fn("Drizzle.readSnapshots")(function* (out: string) {
        const snapshots: Record<string, { snapshot: Snapshot; text: string }> = {};
        for (const dir of yield* listMigrationDirs(out)) {
          const snapshotPath = path.join(out, dir, "snapshot.json");
          if (!(yield* fs.exists(snapshotPath))) continue;
          const text = yield* fs.readFileString(snapshotPath);
          snapshots[dir] = { snapshot: JSON.parse(text) as Snapshot, text };
        }
        return snapshots;
      });

      // The latest snapshot is the head of the `prevIds` chain — the one no
      // other snapshot points back to. Directory-name order alone is not
      // enough: two migrations generated within the same second share the
      // timestamp prefix, and the random name suffix then decides the sort.
      const readLatestSnapshot = Effect.fn("Drizzle.readLatestSnapshot")(function* (out: string) {
        const entries = Object.values(yield* readSnapshots(out));
        if (entries.length === 0) return undefined;
        const referenced = new Set(entries.flatMap((entry) => entry.snapshot.prevIds ?? []));
        const head = entries.find(
          (entry) => entry.snapshot.id !== undefined && !referenced.has(entry.snapshot.id),
        );
        // Fall back to name order for snapshots without id/prevIds chains.
        const latest = head ?? entries[entries.length - 1]!;
        return { snapshot: latest.snapshot, hash: sha(latest.text) };
      });

      const copyDirectory: (from: string, to: string) => Effect.Effect<void, PlatformError> =
        Effect.fn("Drizzle.copyDirectory")(function* (from: string, to: string) {
          yield* fs.makeDirectory(to, { recursive: true });
          for (const entry of yield* fs.readDirectory(from)) {
            const source = path.join(from, entry);
            const target = path.join(to, entry);
            if ((yield* fs.stat(source)).type === "Directory") {
              yield* copyDirectory(source, target);
            } else {
              yield* fs.writeFile(target, yield* fs.readFile(source));
            }
          }
        });

      const drizzleKit = Effect.fn("Drizzle.kit")(function* (
        command: "generate" | "up",
        options: Parameters<DrizzleKitCli["generate"]>[0],
      ) {
        const cli = yield* importModule<DrizzleKitCli>("drizzle-kit/cli");
        const result = yield* Effect.tryPromise({
          try: () => cli[command](options),
          catch: (cause) => new DrizzleKitFailed({ command, cause }),
        });
        if (result.status === "error") {
          return yield* new DrizzleKitFailed({ command, cause: result.error });
        }
        return result;
      });

      /**
       * Bring a migrations folder up to drizzle-kit's current snapshot format:
       * `drizzle-kit up` for older format versions, then
       * {@link convertLegacyPostgres}. Returns whether anything changed.
       */
      const upgradeFolder = Effect.fn("Drizzle.upgradeFolder")(function* (
        props: SchemaProps,
        out: string,
      ) {
        if (!(yield* fs.exists(out))) return false;
        const upped = yield* drizzleKit("up", {
          dialect: cliDialect(props),
          schema: resolveSchema(props),
          out,
        });
        const converted = cliDialect(props) === "postgresql" && (yield* convertLegacyPostgres(out));
        return (
          converted ||
          (Predicate.hasProperty(upped, "upgraded") &&
            Array.isArray(upped.upgraded) &&
            upped.upgraded.length > 0)
        );
      });

      /**
       * Alchemy used to write every postgres snapshot as a full,
       * untyped version-9 snapshot. drizzle-kit now expects one `base`
       * snapshot followed by `diff` snapshots, and rejects the old files as
       * malformed. Rewrite them as base/diff, verify drizzle-kit reconstructs
       * every converted snapshot to exactly its original schema, and only
       * then write the files.
       */
      const convertLegacyPostgres = Effect.fn("Drizzle.convertLegacyPostgres")(function* (
        out: string,
      ) {
        const snapshots = yield* readSnapshots(out);
        const isLegacy = (snapshot: Snapshot) =>
          snapshot.type === undefined && snapshot.version === "9" && snapshot.ddl !== undefined;
        const legacy = Object.keys(snapshots).filter((dir) => isLegacy(snapshots[dir]!.snapshot));
        if (legacy.length === 0) return false;

        const { reconstruct } = yield* importModule<DrizzleKitPayload>(
          "drizzle-kit/payload/postgres",
        );
        const files: Record<string, Snapshot> = {};
        const ddlById = new Map<string, ReadonlyArray<DdlEntry>>();
        for (const [dir, { snapshot }] of Object.entries(snapshots)) {
          if (!isLegacy(snapshot)) files[dir] = snapshot;
          else if (snapshot.id !== undefined) ddlById.set(snapshot.id, snapshot.ddl ?? []);
        }
        let hasBase = Object.values(files).some((snapshot) => snapshot.type === "base");

        const reconstructDdl = (id: string) =>
          Effect.tryPromise({
            try: () => reconstruct!({ ...files }, id),
            catch: (cause) => new DrizzleKitFailed({ command: "reconstruct", cause }),
          }).pipe(Effect.map((state) => state.ddl ?? []));

        for (const dir of legacy) {
          const { ddl = [], ...snapshot } = snapshots[dir]!.snapshot;
          const parent = snapshot.prevIds?.[0] ?? ORIGIN;
          if (parent === ORIGIN && !hasBase) {
            files[dir] = { type: "base", ...snapshot, ddl, footprints: [] } as Snapshot;
            hasBase = true;
            continue;
          }
          const parentDdl =
            parent === ORIGIN ? [] : (ddlById.get(parent) ?? (yield* reconstructDdl(parent)));
          files[dir] = {
            type: "diff",
            ...snapshot,
            footprints: [],
            deltas: ddlDeltas(parentDdl, ddl),
          } as Snapshot;
        }

        for (const dir of legacy) {
          const original = snapshots[dir]!.snapshot;
          const rebuilt = yield* reconstructDdl(original.id ?? "");
          if (!sameDdl(rebuilt, original.ddl ?? [])) {
            return yield* new SnapshotConversionFailed({ folder: path.join(out, dir) });
          }
        }
        for (const dir of legacy) {
          yield* fs.writeFileString(
            path.join(out, dir, "snapshot.json"),
            JSON.stringify(files[dir], null, 2),
          );
        }
        return true;
      });

      /**
       * The previous and current schema, for working out which entities a
       * rename-or-create question could have been renamed from.
       */
      const loadRenameContext = Effect.fn("Drizzle.loadRenameContext")(function* (
        props: SchemaProps,
        out: string,
      ) {
        const dialect = props.dialect ?? "postgres";
        const kit = yield* importModule<DrizzleKitPayload>(`drizzle-kit/payload/${dialect}`);
        const schemaModule = yield* Effect.tryPromise({
          try: () =>
            import(/* @vite-ignore */ resolveSchema(props)) as Promise<Record<string, unknown>>,
          catch: (cause) => new SchemaImportFailed({ schema: props.schema, cause }),
        });
        const cur = yield* Effect.tryPromise({
          try: () => kit.generateDrizzleJson(schemaModule),
          catch: (cause) => new DrizzleKitFailed({ command: "generateDrizzleJson", cause }),
        });
        const snapshots = yield* readSnapshots(out);
        const reconstruct = kit.reconstruct;
        const prev =
          reconstruct !== undefined
            ? Object.keys(snapshots).length === 0
              ? {}
              : yield* Effect.tryPromise({
                  try: () =>
                    reconstruct(
                      Object.fromEntries(
                        Object.entries(snapshots).map(([dir, { snapshot }]) => [dir, snapshot]),
                      ),
                    ),
                  catch: (cause) => new DrizzleKitFailed({ command: "reconstruct", cause }),
                })
            : ((yield* readLatestSnapshot(out))?.snapshot ?? {});
        return { prev: prev.ddl ?? [], cur: cur.ddl ?? [] };
      });

      /**
       * Dry-run `drizzle-kit generate` until it has no unanswered questions,
       * asking the user each rename-or-create question it reports. The SQL is
       * applied to the real database later in the same deploy, so ambiguous
       * changes are never answered automatically.
       */
      const resolveHints = Effect.fn("Drizzle.resolveHints")(function* (
        props: SchemaProps,
        out: string,
      ) {
        const hints: Array<Hint> = [];
        let context: { prev: ReadonlyArray<DdlEntry>; cur: ReadonlyArray<DdlEntry> } | undefined;
        while (true) {
          const result = yield* drizzleKit("generate", {
            dialect: cliDialect(props),
            schema: resolveSchema(props),
            out,
            explain: true,
            hints,
          });
          if (result.status !== "missing_hints") {
            const changed = result.status === "ok" && (result.statements?.length ?? 1) > 0;
            return { hints, changed };
          }
          context ??= yield* loadRenameContext(props, out);
          for (const hint of result.unresolved) {
            hints.push(yield* askHint(props, hint, context.prev, context.cur, hints));
          }
        }
      });

      /**
       * Decide what a deploy would change, without touching `out`: upgrade a
       * scratch copy of the folder, then resolve every question drizzle-kit
       * has about the schema change. Cached so `diff` and `reconcile` share
       * one set of answers.
       */
      const detectDrift = Effect.fn("Drizzle.detectDrift")(
        function* (props: SchemaProps) {
          const out = resolveOut(props);
          const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-drizzle-" });
          const migrations = path.join(scratch, "migrations");
          if (yield* fs.exists(out)) yield* copyDirectory(out, migrations);
          const upgraded = yield* upgradeFolder(props, migrations);
          const { hints, changed } = yield* resolveHints(props, migrations);
          return { out, upgraded, hints, changed };
        },
        Effect.scoped,
        Artifacts.cached("detectDrift"),
      );

      /**
       * Upgrade `out` if needed and generate the pending migration with the
       * answers gathered by {@link detectDrift}.
       */
      const regenerate = Effect.fn("Drizzle.regenerate")(function* (props: SchemaProps) {
        const { out, upgraded, hints, changed } = yield* detectDrift(props);
        if (upgraded) yield* upgradeFolder(props, out);
        if (changed) {
          yield* fs.makeDirectory(out, { recursive: true });
          const result = yield* drizzleKit("generate", {
            dialect: cliDialect(props),
            schema: resolveSchema(props),
            out,
            hints,
          });
          if (result.status === "missing_hints") {
            return yield* new UndecidedSchemaChange({ props, hint: result.unresolved[0]! });
          }
        }
        const latest = yield* readLatestSnapshot(out);
        return {
          out: relativeOut(out),
          snapshotHash: latest?.hash ?? sha(""),
          migrations: yield* listMigrationDirs(out),
        };
      });

      return {
        // Non-listable: a Drizzle.Schema is a local build artifact (generated
        // migration SQL under `out`, a path supplied entirely by props with no
        // account/store to enumerate). There is no remote enumeration API, so
        // there is nothing to discover out-of-band.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          // Only flag an update when drizzle-kit would emit new SQL (or the
          // folder needs upgrading) — otherwise downstream resources (e.g.
          // Neon.Branch) would see `schema.out` as an unresolved Output during
          // plan and cascade into spurious updates of their own.
          const { changed, upgraded } = yield* detectDrift(news);
          // Originally `output.out` was an absolute path, which is not portable.
          // So, we trigger an update to migrate existing resources to the
          // canonical (cwd-relative) form. This is safe because `regenerate`
          // is idempotent. Compare against the canonical form rather than
          // testing `isAbsolute`: on Windows a cross-drive `out` can never be
          // relativized, so its canonical form IS absolute and an isAbsolute
          // check would flag an update on every deploy.
          return changed || upgraded || output.out !== relativeOut(resolveOut(news))
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
            `${output ? "Regenerating" : "Generating"} drizzle migrations for ${news.schema}`,
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

// An entity's identity: whichever of schema/table/name its type has.
const identity = (row: DdlEntry) =>
  (["schema", "table", "name"] as const).filter((field) => field in row).map((field) => row[field]);

// drizzle-kit's entity key: the entity type plus its identity.
const entityKey = (row: DdlEntry) => `${row.entityType}\0${JSON.stringify(identity(row))}`;

// Fields sorted and nulls dropped, so two rows compare equal when drizzle-kit
// would treat them as the same state.
const normalizedRow = (row: DdlEntry) =>
  JSON.stringify(
    Object.keys(row)
      .filter((field) => row[field] !== null && row[field] !== undefined)
      .sort()
      .map((field) => [field, row[field]]),
  );

const sameDdl = (a: ReadonlyArray<DdlEntry>, b: ReadonlyArray<DdlEntry>) => {
  const left = a.map(normalizedRow).sort();
  const right = b.map(normalizedRow).sort();
  return left.length === right.length && left.every((row, i) => row === right[i]);
};

// Children (columns, indexes, …) are dropped before and created after their
// parents (tables, schemas).
const depth = (row: DdlEntry) => identity(row).length;

/** The `deltas` of a postgres `diff` snapshot taking `from` to `to`. */
const ddlDeltas = (from: ReadonlyArray<DdlEntry>, to: ReadonlyArray<DdlEntry>) => {
  const before = new Map(from.map((row) => [entityKey(row), row]));
  const after = new Map(to.map((row) => [entityKey(row), row]));
  const drops = [...before.values()]
    .filter((row) => !after.has(entityKey(row)))
    .sort((a, b) => depth(b) - depth(a))
    .map((row) => ({ op: "drop", key: entityKey(row) }));
  const alters = [...after.values()].flatMap((row) => {
    const old = before.get(entityKey(row));
    if (old === undefined || normalizedRow(old) === normalizedRow(row)) return [];
    const set = Object.fromEntries(
      Object.keys({ ...old, ...row })
        .filter(
          (field) => JSON.stringify(old[field] ?? null) !== JSON.stringify(row[field] ?? null),
        )
        .map((field) => [field, row[field] ?? null]),
    );
    return [{ op: "alter", key: entityKey(row), set }];
  });
  const creates = [...after.values()]
    .filter((row) => !before.has(entityKey(row)))
    .sort((a, b) => depth(a) - depth(b))
    .map((row) => ({ op: "create", row }));
  return [...drops, ...alters, ...creates];
};

// drizzle-kit hint kinds → snapshot `ddl` entity types.
const ddlEntityTypes: Record<string, string> = {
  table: "tables",
  column: "columns",
  index: "indexes",
  enum: "enums",
  sequence: "sequences",
  view: "views",
  schema: "schemas",
  policy: "policies",
  role: "roles",
  check: "checks",
  unique: "uniques",
  primary_key: "pks",
  "foreign key": "fks",
};

// mysql and sqlite have no schemas; drizzle-kit fills ids with `public`.
const DEFAULT_SCHEMA = "public";

const formatEntity = (entity: ReadonlyArray<string>) =>
  (entity.length > 1 && entity[0] === DEFAULT_SCHEMA ? entity.slice(1) : entity).join(".");

type Located = { entityType: string; schema: string; table: string; name: string };

const locate = (row: DdlEntry): Located => ({
  entityType: row.entityType,
  schema: row.schema ?? DEFAULT_SCHEMA,
  table: row.table ?? "",
  name: row.name ?? "",
});

const idOf = (row: Located, arity: number) =>
  arity === 1
    ? [row.name]
    : arity === 2
      ? [row.schema, row.name]
      : [row.schema, row.table, row.name];

/**
 * Carry previous entities through the renames answered so far, so a later
 * question about the renamed table (or a table moved to another schema)
 * matches the entities that moved with it.
 */
const applyRenames = (rows: ReadonlyArray<Located>, hints: ReadonlyArray<Hint>) =>
  hints.reduce(
    (current, hint) =>
      hint.type !== "rename"
        ? current
        : current.map((row) => {
            const [from, to] = [hint.from, hint.to];
            if (hint.kind === "schema") {
              return row.schema === from[0]
                ? {
                    ...row,
                    schema: to[0]!,
                    ...(row.entityType === "schemas" ? { name: to[0]! } : {}),
                  }
                : row;
            }
            if (hint.kind === "table" && row.schema === from[0]) {
              if (row.entityType === "tables" && row.name === from[1]) {
                return { ...row, schema: to[0]!, name: to[1]! };
              }
              if (row.table === from[1]) return { ...row, schema: to[0]!, table: to[1]! };
              return row;
            }
            const id = JSON.stringify(idOf(row, from.length));
            return row.entityType === ddlEntityTypes[hint.kind] && id === JSON.stringify(from)
              ? from.length === 3
                ? { ...row, schema: to[0]!, table: to[1]!, name: to[2]! }
                : from.length === 2
                  ? { ...row, schema: to[0]!, name: to[1]! }
                  : { ...row, name: to[0]! }
              : row;
          }),
    rows,
  );

/**
 * Entities a rename-or-create question could have been renamed from: same
 * kind, present before (after the renames answered so far), gone now.
 * Columns, indexes, … are offered from the same table first.
 */
const renameCandidates = (
  hint: MissingHint,
  prev: ReadonlyArray<DdlEntry>,
  cur: ReadonlyArray<DdlEntry>,
  hints: ReadonlyArray<Hint>,
) => {
  const entityType = ddlEntityTypes[hint.kind];
  const arity = hint.entity.length;
  const ofKind = (rows: ReadonlyArray<Located>) =>
    rows.filter((row) => row.entityType === entityType);
  const current = new Set(ofKind(cur.map(locate)).map((row) => JSON.stringify(idOf(row, arity))));
  const gone = ofKind(applyRenames(prev.map(locate), hints))
    .map((row) => idOf(row, arity))
    .filter((id) => !current.has(JSON.stringify(id)));
  const sameParent = gone.filter(
    (id) => arity < 3 || (id[0] === hint.entity[0] && id[1] === hint.entity[1]),
  );
  return sameParent.length > 0 ? sameParent : gone;
};

/**
 * Answer one drizzle-kit `MissingHint` with an Alchemy prompt. drizzle-kit
 * only asks when a rename is possible, so the question is always shown —
 * never answered with "create" on the user's behalf. A dismissed prompt stays
 * a `TerminalCancelled` so the CLI exits quietly, the same as cancelling the
 * deploy confirmation.
 */
const askHint = Effect.fn("Drizzle.askHint")(
  function* (
    props: SchemaProps,
    hint: MissingHint,
    prev: ReadonlyArray<DdlEntry>,
    cur: ReadonlyArray<DdlEntry>,
    hints: ReadonlyArray<Hint>,
  ) {
    const interaction = yield* Effect.serviceOption(Interaction);
    if (Option.isNone(interaction)) return yield* new UndecidedSchemaChange({ props, hint });

    const name = formatEntity(hint.entity);
    return yield* interaction.value.prompt.select<Hint>({
      message: `Is ${hint.kind} ${name} created or renamed from another ${hint.kind}?`,
      options: [
        {
          value: { type: "create", kind: hint.kind, entity: hint.entity },
          label: `+ ${name}`,
          description: `create ${hint.kind}`,
        },
        ...renameCandidates(hint, prev, cur, hints).map((from) => ({
          value: { type: "rename", kind: hint.kind, from, to: hint.entity } satisfies Hint,
          label: `~ ${formatEntity(from)} › ${name}`,
          description: `rename ${hint.kind}`,
        })),
      ],
      descriptionPlacement: "inline",
    });
  },
  (effect, props, hint) =>
    effect.pipe(
      Effect.catchTag("NonInteractiveTerminal", () =>
        Effect.fail(new UndecidedSchemaChange({ props, hint })),
      ),
    ),
);
