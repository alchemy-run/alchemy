/**
 * Wrangler-project generation for Celld fleet deploys.
 *
 * `celld deploy` consumes a wrangler.jsonc project and REJECTS unknown keys,
 * so {@link renderWranglerJson} emits only the keys celld documents support
 * for: `name`, `main`, `compatibility_date`, `compatibility_flags`,
 * `durable_objects`, `migrations`, `vars`.
 *
 * Durable Object class migrations follow the wrangler convention: the config
 * carries the FULL migration history (each entry tagged `v1`, `v2`, …), and
 * the runtime applies whatever tags it hasn't seen. The history and the
 * resulting `logicalId → className` map are persisted on the Fleet's own
 * Attributes — the durable metadata store Cloudflare Workers had to fake
 * with script tags.
 *
 * @internal not exported from the Celld barrel.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export interface CelldMigration {
  readonly tag: string;
  readonly new_sqlite_classes?: string[];
  readonly renamed_classes?: { from: string; to: string }[];
  readonly deleted_classes?: string[];
}

export interface FleetDurableObjectBinding {
  /** Binding name — the Durable Object's logical id. */
  readonly name: string;
  /** The exported class name backing the binding. */
  readonly className: string;
}

/**
 * A class-migration set that cannot be expressed safely — e.g. a rename
 * whose target class name is simultaneously deleted or created by another
 * binding. Raised BEFORE anything is deployed: never risk destroying cell
 * data on an ambiguous migration.
 */
export class CelldMigrationConflictError extends Data.TaggedError(
  "Celld.MigrationConflictError",
)<{
  readonly message: string;
}> {}

const nextTag = (history: readonly CelldMigration[]): string => {
  const last = history.at(-1);
  const n = last ? Number.parseInt(last.tag.replace(/^v/, ""), 10) : 0;
  return `v${(Number.isFinite(n) ? n : history.length) + 1}`;
};

/**
 * Compute the migration delta between the persisted `logicalId → className`
 * map and the current bindings, appending it (when non-empty) to the
 * persisted migration history.
 */
export const computeFleetMigrations = ({
  history = [],
  oldClasses = {},
  current,
}: {
  /** Persisted migration history from the Fleet's Attributes. */
  history?: readonly CelldMigration[];
  /** Persisted `logicalId → className` map from the Fleet's Attributes. */
  oldClasses?: Record<string, string>;
  /** The Durable Object bindings declared by this deploy. */
  current: readonly FleetDurableObjectBinding[];
}): Effect.Effect<
  {
    migrations: CelldMigration[];
    classes: Record<string, string>;
  },
  CelldMigrationConflictError
> =>
  Effect.gen(function* () {
    const classes: Record<string, string> = {};
    const classNames = new Set<string>();
    for (const binding of current) {
      if (classes[binding.name] !== undefined) {
        return yield* Effect.fail(
          new CelldMigrationConflictError({
            message: `Duplicate Durable Object binding '${binding.name}'.`,
          }),
        );
      }
      if (classNames.has(binding.className)) {
        return yield* Effect.fail(
          new CelldMigrationConflictError({
            message: `Durable Object class '${binding.className}' is declared by more than one binding — each binding needs its own class name.`,
          }),
        );
      }
      classes[binding.name] = binding.className;
      classNames.add(binding.className);
    }

    const newSqliteClasses: string[] = [];
    const renamedClasses: { from: string; to: string }[] = [];
    const deletedClasses: string[] = [];

    for (const binding of current) {
      const previous = oldClasses[binding.name];
      if (previous === undefined) {
        newSqliteClasses.push(binding.className);
      } else if (previous !== binding.className) {
        renamedClasses.push({ from: previous, to: binding.className });
      }
    }
    for (const [logicalId, className] of Object.entries(oldClasses)) {
      if (classes[logicalId] === undefined) {
        deletedClasses.push(className);
      }
    }

    // Fail-before-deploy: a class name that is simultaneously the target of
    // a rename and a delete (or a create) is ambiguous — the runtime could
    // destroy the wrong namespace's data.
    for (const renamed of renamedClasses) {
      if (deletedClasses.includes(renamed.to)) {
        return yield* Effect.fail(
          new CelldMigrationConflictError({
            message: `Ambiguous migration: class '${renamed.to}' is both the target of a rename (from '${renamed.from}') and deleted by another binding. Split this into two deploys.`,
          }),
        );
      }
      if (deletedClasses.includes(renamed.from)) {
        return yield* Effect.fail(
          new CelldMigrationConflictError({
            message: `Ambiguous migration: class '${renamed.from}' is both renamed to '${renamed.to}' and deleted. Split this into two deploys.`,
          }),
        );
      }
    }

    if (
      newSqliteClasses.length === 0 &&
      renamedClasses.length === 0 &&
      deletedClasses.length === 0
    ) {
      return { migrations: [...history], classes };
    }

    const delta: CelldMigration = {
      tag: nextTag(history),
      ...(newSqliteClasses.length > 0
        ? { new_sqlite_classes: newSqliteClasses.sort() }
        : {}),
      ...(renamedClasses.length > 0
        ? {
            renamed_classes: renamedClasses.sort((a, b) =>
              a.from.localeCompare(b.from),
            ),
          }
        : {}),
      ...(deletedClasses.length > 0
        ? { deleted_classes: deletedClasses.sort() }
        : {}),
    };

    return { migrations: [...history, delta], classes };
  });

export interface WranglerRenderOptions {
  readonly name: string;
  /** Path of the entry module, relative to the staged project directory. */
  readonly main: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
  readonly durableObjects: readonly FleetDurableObjectBinding[];
  readonly migrations: readonly CelldMigration[];
  readonly vars?: Record<string, string>;
}

/**
 * Render the wrangler.json for a fleet deploy. ONLY celld-supported keys are
 * emitted — an unknown key fails the deploy.
 */
export const renderWranglerJson = (options: WranglerRenderOptions): string =>
  `${JSON.stringify(
    {
      name: options.name,
      main: options.main,
      compatibility_date: options.compatibilityDate,
      ...(options.compatibilityFlags && options.compatibilityFlags.length > 0
        ? { compatibility_flags: options.compatibilityFlags }
        : {}),
      ...(options.durableObjects.length > 0
        ? {
            durable_objects: {
              bindings: options.durableObjects.map((binding) => ({
                name: binding.name,
                class_name: binding.className,
              })),
            },
          }
        : {}),
      ...(options.migrations.length > 0
        ? {
            migrations: options.migrations.map((migration) => ({
              tag: migration.tag,
              ...(migration.new_sqlite_classes
                ? { new_sqlite_classes: migration.new_sqlite_classes }
                : {}),
              ...(migration.renamed_classes
                ? { renamed_classes: migration.renamed_classes }
                : {}),
              ...(migration.deleted_classes
                ? { deleted_classes: migration.deleted_classes }
                : {}),
            })),
          }
        : {}),
      ...(options.vars && Object.keys(options.vars).length > 0
        ? { vars: options.vars }
        : {}),
    },
    null,
    2,
  )}\n`;
