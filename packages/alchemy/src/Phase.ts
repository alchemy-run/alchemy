import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AlchemyContext } from "./AlchemyContext.ts";

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
  /**
   * Build-time constant naming the cloud identity a bundle's host runs as,
   * defined by the bundler of a host that has one: `"AWS.IAM.Role"` for a
   * Lambda, ECS task or EC2 instance, `"GCP.IAM.ServiceAccount"` for Cloud Run,
   * Cloud Functions or GKE, `"Fly.OIDC"` for a Fly Service's Machines.
   * `undefined` everywhere else.
   *
   * A provider's bindings compare it against their own identity type to drop
   * the code that host never runs (signing with a key Alchemy created).
   */
  var __ALCHEMY_HOST_IDENTITY__: string | undefined;
}

export type AlchemyPhase = "plan" | "runtime";

export const ALCHEMY_PHASE = Config.String("ALCHEMY_PHASE").pipe(
  Config.withDefault("plan"),
  Config.mapEffect((value) => {
    if (value !== "plan" && value !== "runtime") {
      return Effect.die(new Error(`Invalid ALCHEMY_PHASE: ${value}`));
    }
    return Effect.succeed(value as AlchemyPhase);
  }),
  Effect.orDie,
);

/**
 * Whether the program is running in local dev mode, i.e. on local providers.
 *
 * While a stack is evaluated it reads `AlchemyContext.dev`, the same flag that
 * picks local or live providers, so it is `true` under `alchemy dev` and
 * under `Test.make({ dev: true })` / `ALCHEMY_TEST_DEV=1`. Outside a stack
 * (e.g. a deployed runtime) it falls back to the `ALCHEMY_DEV` environment
 * variable / config key, which `alchemy dev` sets on its process and which
 * defaults to `false`.
 *
 * Read it from user code to branch on dev mode:
 *
 * ```typescript
 * import { ALCHEMY_DEV } from "alchemy";
 *
 * Effect.gen(function* () {
 *   if (yield* ALCHEMY_DEV) {
 *     // local-dev-only behavior
 *   }
 * });
 * ```
 */
export const ALCHEMY_DEV = Config.Boolean("ALCHEMY_DEV").pipe(
  Config.withDefault(false),
  Config.mapEffect((fromEnv) =>
    Effect.serviceOption(AlchemyContext).pipe(
      Effect.map((context) => (Option.isSome(context) ? context.value.dev : fromEnv)),
    ),
  ),
);
