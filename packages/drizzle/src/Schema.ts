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

type GenerateOptions = {
  dialect: string;
  schema: string;
  out: string;
  explain?: boolean;
  hints?: Array<Hint>;
};

type UpOptions = { dialect: string; out: string };

type GenerateResult =
  | { status: "ok" }
  | { status: "no_changes" }
  | { status: "missing_hints"; unresolved: ReadonlyArray<MissingHint> };

type UpResult = { status: "ok"; upgraded: ReadonlyArray<string> };

type CommandFailed = { status: "error"; error: unknown };

// `drizzle-kit/cli`: the `drizzle-kit` commands as functions. They never
// prompt and report results (including unanswered questions) as values.
type DrizzleKitCli = {
  generate: (options: GenerateOptions) => Promise<GenerateResult | CommandFailed>;
  up: (options: UpOptions) => Promise<UpResult | CommandFailed>;
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
    // Thrown errors carry their own message; reported ones (`{ status:
    // "error", error }`) are plain objects like `{ code, kind, snapshot }`.
    const { cause } = this;
    const detail = cause instanceof Error ? cause.message : JSON.stringify(cause);
    return `drizzle-kit ${this.command} failed: ${detail}`;
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
      `${props.schema} has an ambiguous change that needs a decision:`,
      `  ${formatEntity(hint.entity)}: created or renamed?`,
      "Re-run in an interactive terminal to answer it.",
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

const cliDialect = (props: SchemaProps) =>
  props.dialect === undefined || props.dialect === "postgres" ? "postgresql" : props.dialect;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const importModule = <A>(module: string) =>
  Effect.tryPromise({
    try: () => import(/* @vite-ignore */ module) as Promise<A>,
    catch: (cause) => new DrizzleKitLoadFailed({ module, cause }),
  });

const isCommandFailed = (result: { status: string }): result is CommandFailed =>
  result.status === "error";

// Run a `drizzle-kit/cli` command, failing on a thrown or reported error.
const runCommand = <A extends { status: string }>(
  command: keyof DrizzleKitCli,
  run: (cli: DrizzleKitCli) => Promise<A | CommandFailed>,
) =>
  importModule<DrizzleKitCli>("drizzle-kit/cli").pipe(
    Effect.flatMap((cli) =>
      Effect.tryPromise({
        try: () => run(cli),
        catch: (cause) => new DrizzleKitFailed({ command, cause }),
      }),
    ),
    Effect.flatMap((result) =>
      isCommandFailed(result)
        ? Effect.fail(new DrizzleKitFailed({ command, cause: result.error }))
        : Effect.succeed(result),
    ),
  );

/** The `drizzle-kit` commands Drizzle.Schema runs. */
const drizzleKit = {
  /** `drizzle-kit generate`; with `explain` a dry run that writes nothing. */
  generate: Effect.fn("drizzleKit.generate")(function* (options: GenerateOptions) {
    return yield* runCommand("generate", (cli) => cli.generate(options));
  }),
  /** `drizzle-kit up`: upgrade snapshots to the current format. */
  up: Effect.fn("drizzleKit.up")(function* (options: UpOptions) {
    return yield* runCommand("up", (cli) => cli.up(options));
  }),
};

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

      /**
       * Bring a migrations folder up to drizzle-kit's current snapshot format
       * with `drizzle-kit up`. Returns whether anything changed.
       *
       * Earlier Alchemy versions wrote every postgres snapshot as a full
       * version-9 snapshot without a `type`. That is the version-8 shape, which
       * `up` turns into drizzle-kit's base/diff chain, so relabel them first.
       */
      const upgradeFolder = Effect.fn("Drizzle.upgradeFolder")(function* (
        props: SchemaProps,
        out: string,
      ) {
        if (!(yield* fs.exists(out))) return false;
        if (cliDialect(props) === "postgresql") {
          for (const [dir, { snapshot }] of Object.entries(yield* readSnapshots(out))) {
            if (snapshot.type !== undefined || snapshot.version !== "9") continue;
            yield* fs.writeFileString(
              path.join(out, dir, "snapshot.json"),
              JSON.stringify({ ...snapshot, version: "8", renames: [] }, null, 2),
            );
          }
        }
        const { upgraded } = yield* drizzleKit.up({ dialect: cliDialect(props), out });
        return upgraded.length > 0;
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
          // `explain` dry-runs generate: it reports the pending migration
          // (`ok`), `no_changes`, or the questions it still needs answered
          // (`missing_hints`) without writing anything.
          const result = yield* drizzleKit.generate({
            dialect: cliDialect(props),
            schema: resolveSchema(props),
            out,
            explain: true,
            hints,
          });
          if (result.status !== "missing_hints") {
            return { hints, changed: result.status === "ok" };
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
          const result = yield* drizzleKit.generate({
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
          if (!output) {
            // A create never reaches `diff`; plan only calls `read` to look
            // for something to adopt. Ask any rename questions now so they
            // are answered before apply starts changing other resources.
            if (olds && isResolved(olds)) yield* detectDrift(olds);
            return undefined;
          }
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
              // Schema rows name themselves; everything else names its schema.
              const own = row.entityType === "schemas" ? row.name : row.schema;
              return own === from[0]
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
