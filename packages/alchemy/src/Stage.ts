import * as Context from "effect/Context";

/**
 * Augmentable interface that drives the static type of {@link Stage}.
 *
 * Consumers don't write this `declare module` block by hand. The
 * `alchemy types` CLI command parses the `stages` array passed to
 * `Alchemy.Stack(...)` and emits `.alchemy/types.d.ts`:
 *
 * ```ts
 * declare module "alchemy" {
 *   interface Stages {
 *     dev: true;
 *     staging: true;
 *     prod: true;
 *   }
 * }
 * ```
 *
 * When the interface stays empty (no generated file, fresh checkout),
 * {@link StageName} falls back to `string` so the framework keeps
 * compiling.
 */
export interface Stages {}

/**
 * Union of stage names declared via {@link Stages}, falling back to
 * `string` when no augmentation is in scope.
 *
 * The exported `Stage` declaration below uses this alias as a deferred
 * type reference so the lib's emitted `.d.ts` keeps it symbolic. That's
 * what lets a consumer-side augmentation of `Stages` actually narrow
 * `yield* Stage` at consumer compile time.
 */
export type StageName = keyof Stages extends never
  ? string
  : keyof Stages & string;

export interface Stage extends Context.ServiceClass.Shape<"Stage", StageName> {}

export const Stage: Context.ServiceClass<Stage, "Stage", StageName> =
  Context.Service<Stage, StageName>()("Stage") as Context.ServiceClass<
    Stage,
    "Stage",
    StageName
  >;
