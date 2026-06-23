import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

declare global {
  /**
   * Build-time flag marking the runtime (post-bundle) phase.
   *
   * The bundler folds this to `true` in every runtime artifact (see
   * `ALCHEMY_DEFINE` in `Bundle/Bundle.ts`), so plan-only code guarded by
   * `if (!globalThis.__ALCHEMY_RUNTIME__)` is dead-code-eliminated from deployed
   * Workers/Lambdas/Containers.
   *
   * When running source directly with bun/node (no bundler) it is `undefined`
   * (falsy), so plan-only branches run. Reading it never throws because it is a
   * property access on `globalThis`.
   */
  var __ALCHEMY_RUNTIME__: boolean | undefined;
}

export type AlchemyPhase = "plan" | "runtime";

export const ALCHEMY_PHASE = Config.string("ALCHEMY_PHASE").pipe(
  Config.withDefault("plan"),
  Config.mapOrFail((value) => {
    if (value !== "plan" && value !== "runtime") {
      return Effect.die(new Error(`Invalid ALCHEMY_PHASE: ${value}`));
    }
    return Effect.succeed(value as AlchemyPhase);
  }),
  Effect.orDie,
);
