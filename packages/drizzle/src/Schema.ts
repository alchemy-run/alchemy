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
import * as Predicate from "effect/Predicate";
import type { Providers } from "./Providers.ts";

export type Dialect = "postgres" | "mysql" | "sqlite";

type DrizzleSnapshot = {
  id?: string;
  prevIds?: string[];
  ddl?: ReadonlyArray<DdlEntry>;
};

type DdlEntry = {
  entityType: string;
  schema?: string;
  table?: string;
  name?: string;
};

// drizzle-kit's `MissingHint` / `Hint`, narrowed to what `generateMigration`
// can ask: rename-or-create. Its `confirm_data_loss` questions need a live
// database (`push` checks whether tables are empty), so generate never raises
// them. Entity ids are tuples: `[name]`, `[schema, name]` or
// `[schema, table, name]`.
type MissingHint = {
  type: "rename_or_create";
  kind: string;
  entity: ReadonlyArray<string>;
};

type Hint =
  | { type: "rename"; kind: string; from: ReadonlyArray<string>; to: ReadonlyArray<string> }
  | { type: "create"; kind: string; entity: ReadonlyArray<string> };

// The shape shared by `drizzle-kit/payload/{postgres,mysql,sqlite}`.
type DrizzleKitApi = {
  generateDrizzleJson: (
    imports: Record<string, unknown>,
    prevId?: string,
  ) => Promise<DrizzleSnapshot>;
  generateMigration: (
    prev: DrizzleSnapshot,
    cur: DrizzleSnapshot,
    options?: { hints?: Hint[] },
  ) => Promise<string[]>;
};

/** drizzle-kit needs answers before it can generate the migration. */
class MissingHints extends Data.TaggedError("MissingHints")<{
  readonly missing: ReadonlyArray<MissingHint>;
}> {}

class GenerateMigrationFailed extends Data.TaggedError("GenerateMigrationFailed")<{
  readonly cause: unknown;
}> {
  override get message() {
    return `drizzle-kit generateMigration failed: ${this.cause}`;
  }
}

/** An ambiguous schema change with no terminal to ask. */
class UndecidedSchemaChange extends Data.TaggedError("UndecidedSchemaChange")<{
  readonly message: string;
}> {}

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
   * Output directory for generated migrations. Each migration is written as
   * `{out}/{timestamp}_migration/{migration.sql, snapshot.json}`. Pass this
   * through as a database resource's `migrations` prop (`Neon.Branch`,
   * `Fly.Postgres`, `Cloudflare.D1.Database`, …) to apply pending
   * migrations on deploy.
   *
   * @default "./migrations"
   */
  out?: string;
  /**
   * SQL dialect to generate migrations for. Selects which
   * `drizzle-kit/payload/*` module is loaded.
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
 * Wraps drizzle-kit's programmatic API (`generateDrizzleJson` /
 * `generateMigration`) so migration SQL is regenerated as part of `alchemy
 * deploy` whenever the source schema changes. The output directory is
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

const dialectModule = (dialect: Dialect): string => {
  switch (dialect) {
    case "postgres":
      return "drizzle-kit/payload/postgres";
    case "mysql":
      return "drizzle-kit/payload/mysql";
    case "sqlite":
      return "drizzle-kit/payload/sqlite";
  }
};

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const tsStamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

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

      const loadSchemaModule = (p: SchemaProps) =>
        Effect.tryPromise({
          try: () =>
            import(/* @vite-ignore */ resolveSchema(p)) as Promise<Record<string, unknown>>,
          catch: (cause) => new Error(`Failed to import schema at ${p.schema}: ${cause}`),
        });

      const loadKit = (dialect: Dialect) =>
        Effect.tryPromise({
          try: () => import(/* @vite-ignore */ dialectModule(dialect)) as Promise<DrizzleKitApi>,
          catch: (cause) =>
            new Error(
              `Failed to load drizzle-kit/${dialect} (is drizzle-kit installed?): ${cause}`,
            ),
        });

      // List `<ts>_*` migration directories under `out`, sorted by numeric
      // prefix. Returns an empty array if `out` doesn't exist.
      const listMigrationDirs = Effect.fn("Drizzle.listMigrationDirs")(function* (out: string) {
        if (!(yield* fs.exists(out))) return [];
        const entries = yield* fs.readDirectory(out);
        return entries.filter((name) => /^\d+_/.test(name)).sort();
      });

      // The latest snapshot is the head of the `prevIds` chain — the one no
      // other snapshot points back to. Directory-name order alone is not
      // enough: two migrations generated within the same second share the
      // timestamp prefix, and the random name suffix then decides the sort.
      const readLatestSnapshot = Effect.fn("Drizzle.readLatestSnapshot")(function* (out: string) {
        const dirs = yield* listMigrationDirs(out);
        const entries: Array<{ snapshot: DrizzleSnapshot; hash: string }> = [];
        for (const dir of dirs) {
          const snapshotPath = path.join(out, dir, "snapshot.json");
          const exists = yield* fs.exists(snapshotPath);
          if (!exists) continue;
          const text = yield* fs.readFileString(snapshotPath);
          entries.push({
            snapshot: JSON.parse(text) as DrizzleSnapshot,
            hash: sha(text),
          });
        }
        if (entries.length === 0) return undefined;
        const referenced = new Set(entries.flatMap((entry) => entry.snapshot.prevIds ?? []));
        const head = entries.find(
          (entry) => entry.snapshot.id !== undefined && !referenced.has(entry.snapshot.id),
        );
        // Fall back to name order for snapshots without id/prevIds chains.
        return head ?? entries[entries.length - 1];
      });

      /**
       * Run drizzle-kit's diff against the latest stored snapshot and
       * return whether any SQL statements would be emitted. Used by both
       * `diff` (to decide whether the resource actually needs an update)
       * and `regenerate` (to decide whether to write a new migration dir).
       */
      const detectDrift = Effect.fn("Drizzle.detectDrift")(function* (props: SchemaProps) {
        const out = resolveOut(props);
        const { generateDrizzleJson, generateMigration } = yield* loadKit(
          props.dialect ?? "postgres",
        );

        const schemaModule = yield* loadSchemaModule(props);
        const prevEntry = yield* readLatestSnapshot(out);
        const cur = yield* Effect.tryPromise({
          try: () => generateDrizzleJson(schemaModule, prevEntry?.snapshot.id),
          catch: (cause) => new Error(`drizzle-kit generateDrizzleJson failed: ${cause}`),
        });

        // For the initial migration, drizzle-kit needs an *empty* snapshot
        // produced by `generateDrizzleJson({})`, not a bare `{}` — the
        // snapshot has internal fields (`ddl`, etc.) that the differ reads.
        const prev =
          prevEntry?.snapshot ??
          (yield* Effect.tryPromise({
            try: () => generateDrizzleJson({}),
            catch: (cause) =>
              new Error(`drizzle-kit generateDrizzleJson (empty baseline) failed: ${cause}`),
          }));

        // An ambiguous change (rename vs create, or one that loses data)
        // rejects with drizzle-kit's `MissingHintsError`. Its SQL is applied
        // to the real database later in the same deploy, so we never answer
        // it automatically: each round asks the user, then retries with
        // the accumulated hints until drizzle-kit has no more questions.
        const hints: Array<Hint> = [];
        while (true) {
          const result = yield* Effect.tryPromise({
            try: () => generateMigration(prev, cur, { hints }),
            catch: (cause) =>
              Predicate.hasProperty(cause, "missingHints")
                ? new MissingHints({ missing: cause.missingHints as Array<MissingHint> })
                : new GenerateMigrationFailed({ cause }),
          }).pipe(Effect.catchTag("MissingHints", Effect.succeed));
          if (!(result instanceof MissingHints)) {
            return { out, cur, prevEntry, sqlStatements: result };
          }
          for (const hint of result.missing) {
            hints.push(yield* askHint(props, hint, prev, cur, hints));
          }
        }
      }, Artifacts.cached("detectDrift"));

      /**
       * Generate a new migration directory if the schema has drifted from
       * the latest snapshot. Returns the new state regardless.
       */
      const regenerate = Effect.fn("Drizzle.regenerate")(function* (props: SchemaProps) {
        const { out, cur, sqlStatements } = yield* detectDrift(props);

        if (sqlStatements.length > 0) {
          yield* fs.makeDirectory(out, { recursive: true });
          const dirName = `${tsStamp()}_migration`;
          const dirPath = path.join(out, dirName);
          yield* fs.makeDirectory(dirPath, { recursive: true });
          const sql = sqlStatements.join("\n--> statement-breakpoint\n") + "\n";
          yield* fs.writeFileString(path.join(dirPath, "migration.sql"), sql);
          yield* fs.writeFileString(
            path.join(dirPath, "snapshot.json"),
            JSON.stringify(cur, null, 2),
          );
        }

        const migrations = yield* listMigrationDirs(out);
        const latest = yield* readLatestSnapshot(out);
        const snapshotHash = latest?.hash ?? sha(JSON.stringify(cur));
        return {
          out: relativeOut(out),
          snapshotHash,
          migrations,
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
          // Only flag an update when drizzle-kit would emit new SQL —
          // otherwise downstream resources (e.g. Neon.Branch) would see
          // `schema.out` as an unresolved Output during plan and cascade
          // into spurious updates of their own.
          const drift = yield* detectDrift(news);
          const changed = drift.sqlStatements.length > 0;
          // Originally `output.out` was an absolute path, which is not portable.
          // So, we trigger an update to migrate existing resources to the
          // canonical (cwd-relative) form. This is safe because `regenerate`
          // is idempotent. Compare against the canonical form rather than
          // testing `isAbsolute`: on Windows a cross-drive `out` can never be
          // relativized, so its canonical form IS absolute and an isAbsolute
          // check would flag an update on every deploy.
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
const formatEntity = (entity: ReadonlyArray<string>) =>
  (entity.length > 1 && entity[0] === "public" ? entity.slice(1) : entity).join(".");

const entityId = (entry: DdlEntry, arity: number, defaultSchema: string, table?: string) => {
  const schema = entry.schema ?? defaultSchema;
  const name = entry.name ?? "";
  return arity === 1
    ? [name]
    : arity === 2
      ? [schema, name]
      : [schema, table ?? entry.table ?? "", name];
};

/**
 * Entities a `rename_or_create` hint could have been renamed from: same kind,
 * present in the previous snapshot, gone from the current one, and not yet
 * claimed by an earlier rename. Hints arrive in rounds and later ones refer
 * to already-renamed tables, so previous entries are re-parented through the
 * table renames answered so far.
 */
const renameCandidates = (
  hint: MissingHint,
  prev: DrizzleSnapshot,
  cur: DrizzleSnapshot,
  hints: ReadonlyArray<Hint>,
) => {
  const entityType = ddlEntityTypes[hint.kind];
  if (entityType === undefined) return [];
  const arity = hint.entity.length;
  const defaultSchema = hint.entity[0] ?? "public";
  const key = (id: ReadonlyArray<string>) => JSON.stringify(id);
  const renamedTables = new Map(
    hints.flatMap((h) =>
      h.type === "rename" && h.kind === "table" ? [[key(h.from), h.to[1]] as const] : [],
    ),
  );
  const claimed = new Set(
    hints.flatMap((h) => (h.type === "rename" && h.kind === hint.kind ? [key(h.from)] : [])),
  );
  const current = new Set(
    (cur.ddl ?? [])
      .filter((entry) => entry.entityType === entityType)
      .map((entry) => key(entityId(entry, arity, defaultSchema))),
  );
  return (prev.ddl ?? [])
    .filter((entry) => entry.entityType === entityType)
    .map((entry) => {
      const schema = entry.schema ?? defaultSchema;
      const table = renamedTables.get(key([schema, entry.table ?? ""])) ?? entry.table;
      return entityId(entry, arity, defaultSchema, table);
    })
    .filter(
      (id) =>
        !current.has(key(id)) &&
        !claimed.has(key(id)) &&
        // Columns, indexes, … can only be renamed within the same table.
        (arity < 3 || (id[0] === hint.entity[0] && id[1] === hint.entity[1])),
    );
};

const undecided = (props: SchemaProps, hint: MissingHint) => {
  const dialect = props.dialect ?? "postgres";
  return new UndecidedSchemaChange({
    message: [
      `drizzle-kit needs a decision for ${props.schema} that cannot be made non-interactively:`,
      `  ${hint.kind} ${formatEntity(hint.entity)}: created or renamed?`,
      "",
      "Re-run the deploy in an interactive terminal to answer it, or generate the migration yourself and commit it:",
      `  npx drizzle-kit generate --dialect ${dialect === "postgres" ? "postgresql" : dialect} --schema ${props.schema} --out ${props.out ?? "./migrations"}`,
    ].join("\n"),
  });
};

/**
 * Answer one drizzle-kit `MissingHint` with an Alchemy prompt. A dismissed
 * prompt stays a `TerminalCancelled` so the CLI exits quietly, the same as
 * cancelling the deploy confirmation.
 */
const askHint = Effect.fn("Drizzle.askHint")(
  function* (
    props: SchemaProps,
    hint: MissingHint,
    prev: DrizzleSnapshot,
    cur: DrizzleSnapshot,
    hints: ReadonlyArray<Hint>,
  ) {
    const interaction = yield* Effect.serviceOption(Interaction);
    if (Option.isNone(interaction)) return yield* undecided(props, hint);
    const { prompt } = interaction.value;

    const create = { type: "create", kind: hint.kind, entity: hint.entity } satisfies Hint;
    const candidates = renameCandidates(hint, prev, cur, hints);
    if (candidates.length === 0) return create;

    const name = formatEntity(hint.entity);
    return yield* prompt.select<Hint>({
      message: `Is ${hint.kind} ${name} created or renamed from another ${hint.kind}?`,
      options: [
        { value: create, label: `+ ${name}`, description: `create ${hint.kind}` },
        ...candidates.map((from) => ({
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
      Effect.catchTag("NonInteractiveTerminal", () => Effect.fail(undecided(props, hint))),
    ),
);
