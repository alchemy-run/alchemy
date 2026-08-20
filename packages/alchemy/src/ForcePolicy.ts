import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Forcing re-runs a node that the engine would otherwise plan as a `noop`:
 * a Resource's `reconcile` runs again against unchanged props, and an
 * {@link Action}'s body runs again against an unchanged input hash.
 *
 * There are two ways to force, and they compose:
 *
 *   1. **Per declaration** — `.pipe(force(...))`, captured at registration
 *      exactly like `adopt()` / `retain()` / `remote()` and stored on the
 *      declaration as `Force`. Applies to every node declared inside the
 *      piped effect, so it can decorate one resource or a whole scope.
 *   2. **Per run** — the CLI's `--force` flag, either as a switch (force
 *      everything) or with an explicit selection (`--force=Seed,Api`).
 *
 * A declaration-level policy always wins over the run-level selection, so
 * `force(false)` is a genuine opt-out: `alchemy deploy --force` re-runs
 * everything *except* nodes pinned with `force(false)`.
 *
 * Forcing never changes the *shape* of a plan — a node that would create,
 * update, replace or delete does exactly that. It only upgrades `noop` to
 * `update` (resources) or `run` (actions).
 */
export class ForcePolicy extends Context.Service<ForcePolicy, boolean>()(
  "ForcePolicy",
) {}

/**
 * The run-level force selection, as produced by the CLI's `--force` flag:
 *
 * - `false` — nothing is forced (the default).
 * - `true` — every node is forced (`--force`).
 * - `string[]` — only the named nodes are forced (`--force=Seed,Api`). Each
 *   entry matches a **logical ID** (`Seed`) or a full **FQN**
 *   (`Backend/Seed`).
 */
export type ForceSelection = boolean | ReadonlyArray<string>;

/**
 * Force the nodes declared inside the piped effect on every deploy, even
 * when nothing about them changed.
 *
 * The common shape is a conditional force driven by config, which gives an
 * on-demand re-run without the declaration ever leaving the stack:
 *
 * @example Re-seed on demand
 * ```typescript
 * const seed = yield* SeedDatabase({ url: db.url }).pipe(
 *   force(yield* Config.boolean("SEED").pipe(Config.withDefault(false))),
 * );
 * ```
 * ```sh
 * alchemy dev            # seeds once, then noops
 * SEED=1 alchemy dev     # re-seeds
 * ```
 *
 * @example Opt one resource out of a `--force` run
 * ```typescript
 * const worker = yield* Worker("Api", { ... }).pipe(force(false));
 * ```
 *
 * @param enabled `true` (the default) forces; `false` pins the node as
 *   never-forced, overriding a run-level `--force`. May also be an `Effect`
 *   producing the boolean.
 */
export const force: {
  // Identity-typed so branded effect interfaces survive the pipe with their
  // brand intact (same treatment as `remote()`).
  (
    enabled?: boolean,
  ): <Eff extends Effect.Effect<any, any, any>>(effect: Eff) => Eff;
  <R1 = never>(
    enabled: Effect.Effect<boolean, never, R1>,
  ): <A, E, R2 = never>(
    effect: Effect.Effect<A, E, R2>,
  ) => Effect.Effect<A, E, R1 | R2>;
} = ((enabled: boolean | Effect.Effect<boolean, never, any> = true) =>
  (eff: Effect.Effect<any, any, any>) =>
    eff.pipe(
      typeof enabled === "boolean"
        ? Effect.provideService(ForcePolicy, enabled)
        : Effect.provideServiceEffect(ForcePolicy, enabled),
    )) as any;

/** A node (resource or action) a force selection can name. */
export interface ForceTarget {
  readonly fqn: string;
  readonly logicalId: string;
}

/**
 * Does the run-level selection name this node? A selection entry matches
 * either the logical ID or the full FQN.
 */
export const selects = (
  selection: ForceSelection | undefined,
  target: ForceTarget,
): boolean =>
  typeof selection === "boolean" || selection === undefined
    ? !!selection
    : selection.some(
        (entry) => entry === target.logicalId || entry === target.fqn,
      );

/**
 * Resolve whether a node is forced on this run. The declaration-level policy
 * (`force(true)` / `force(false)`, captured as `Force` at registration) wins
 * over the run-level selection.
 */
export const isForced = (
  declared: boolean | undefined,
  selection: ForceSelection | undefined,
  target: ForceTarget,
): boolean => declared ?? selects(selection, target);

/**
 * Raised (as a defect) when `--force=<ids>` names something the stack does
 * not declare — almost always a typo, and silently forcing nothing is the
 * worst possible outcome for a flag whose entire job is to make something
 * run.
 */
export class UnknownForceTargetError extends Data.TaggedError(
  "UnknownForceTarget",
)<{
  message: string;
  /** The unmatched `--force=` entries. */
  targets: ReadonlyArray<string>;
  /** Every logical ID declared by the stack. */
  available: ReadonlyArray<string>;
}> {}

/**
 * The `--force=` entries that match no declared node. Empty for a boolean
 * selection (nothing to typo).
 */
export const unmatched = (
  selection: ForceSelection | undefined,
  targets: Iterable<ForceTarget>,
): string[] => {
  if (typeof selection === "boolean" || selection === undefined) return [];
  const known = new Set<string>();
  for (const target of targets) {
    known.add(target.logicalId);
    known.add(target.fqn);
  }
  return selection.filter((entry) => !known.has(entry));
};

export const unknownForceTarget = (
  targets: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
) =>
  new UnknownForceTargetError({
    targets,
    available,
    message: [
      `--force named ${targets.map((t) => `'${t}'`).join(", ")}, which ${
        targets.length === 1
          ? "is not a resource or action"
          : "are not resources or actions"
      } in this stack.`,
      "",
      `Available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
      "",
      "Pass a logical ID (`--force=Seed`) or a fully-qualified name (`--force=Backend/Seed`).",
    ].join("\n"),
  });
