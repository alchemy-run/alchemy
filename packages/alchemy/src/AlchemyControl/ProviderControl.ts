import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { EnvironmentVariable } from "../Auth/AuthProvider.ts";
import { getEnv } from "../Auth/Env.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { collectAuthProviders } from "./AuthProviders.ts";
import type { ControlContext } from "./ControlContext.ts";
import { internalize } from "./ControlEffect.ts";
import {
  InvalidControlInput,
  type CheckEnvironmentInput,
  type EnvironmentCheckResult,
} from "./Surface.ts";

const satisfied = (variable: EnvironmentVariable) =>
  Effect.gen(function* () {
    for (const name of [variable.name, ...(variable.alternatives ?? [])]) {
      const value = yield* getEnv(name);
      if (value !== undefined && value.length > 0) return true;
    }
    return false;
  });

export const makeProviderControl = Effect.gen(function* () {
  const context = yield* Effect.context<ControlContext>();
  return {
    checkEnvironment: (input: CheckEnvironmentInput) =>
      Effect.gen(function* () {
        const registry = yield* collectAuthProviders({
          main: input.entrypoint ?? "alchemy.run.ts",
          envFile: Option.fromNullishOr(input.envFile),
          profile: input.profile,
        });
        const names = yield* input.providers === undefined ||
        input.providers.length === 0
          ? Effect.succeed(Object.keys(registry).sort())
          : Effect.forEach(input.providers, (requested) => {
              const name = Object.keys(registry).find(
                (candidate) =>
                  candidate.toLowerCase() === requested.toLowerCase(),
              );
              if (name === undefined) {
                return Effect.fail(
                  new InvalidControlInput({
                    field: "providers",
                    message: `Unknown provider '${requested}'. Registered: ${Object.keys(registry).sort().join(", ")}.`,
                  }),
                );
              }
              return Effect.succeed(name);
            });
        const provider = yield* loadConfigProvider(
          Option.fromNullishOr(input.envFile),
        );
        const checks = yield* Effect.forEach(names, (name) =>
          Effect.gen(function* () {
            const contract = registry[name]!.environment;
            const missing = [] as Array<{
              alternatives: ReadonlyArray<string>;
            }>;
            for (const variable of contract) {
              if (variable.required && !(yield* satisfied(variable))) {
                missing.push({
                  alternatives: [
                    variable.name,
                    ...(variable.alternatives ?? []),
                  ],
                });
              }
            }
            return {
              provider: name,
              status:
                contract.length === 0
                  ? ("no-contract" as const)
                  : missing.length === 0
                    ? ("satisfied" as const)
                    : ("missing" as const),
              missing,
            };
          }),
        ).pipe(Effect.provide(ConfigProvider.layer(provider)));
        return {
          checks,
          satisfied: checks.every((check) => check.status !== "missing"),
        } satisfies EnvironmentCheckResult;
      }).pipe(Effect.provide(context), internalize),
  };
});

/** Provider environment inspection operations. */
export class ProviderControl extends Context.Service<
  ProviderControl,
  Effect.Success<typeof makeProviderControl>
>()("alchemy/AlchemyControl/Provider") {}

/** Live provider control implementation. */
export const ProviderControlLive = Layer.effect(
  ProviderControl,
  makeProviderControl,
);
