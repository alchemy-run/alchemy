import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { withProfileOverride } from "../Auth/Profile.ts";
import { Stage } from "../Stage.ts";
import * as State from "../State/index.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { fileLogger } from "../Util/FileLogger.ts";
import { importStack } from "./StackSession.ts";
import type { StateSource } from "./State.ts";
import type { ControlContext } from "./ControlContext.ts";
import { internalize } from "./ControlEffect.ts";

export const makeStateResolver = Effect.gen(function* () {
  const context = yield* Effect.context<ControlContext>();
  const injected = yield* Effect.serviceOption(State.State);
  const cache = new Map<string, State.StateService>();

  return (source: StateSource | undefined) =>
    Effect.gen(function* () {
      const selected = source ?? { backend: "injected" as const };
      const key = JSON.stringify(selected);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      let state: State.StateService;
      if (selected.backend === "injected") {
        if (Option.isNone(injected)) return undefined;
        state = yield* injected.value;
      } else if (selected.backend === "local") {
        state = yield* State.State.pipe(
          Effect.flatten,
          Effect.provide(State.localState()),
          Effect.provide(context),
        );
      } else {
        const stackEffect = yield* importStack(selected.entrypoint);
        const services = Layer.mergeAll(
          Layer.succeedContext(
            Context.make(AuthProviders, {}).pipe(
              Context.add(Stage, "placeholder"),
            ),
          ),
          ConfigProvider.layer(
            withProfileOverride(
              yield* loadConfigProvider(Option.fromNullishOr(selected.envFile)),
              selected.profile,
            ),
          ),
          Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        );
        const stack = yield* stackEffect.pipe(Effect.provide(services));
        state = yield* State.State.pipe(
          Effect.flatten,
          Effect.provide(stack.services),
          Effect.provide(services),
          Effect.provide(context),
        );
      }
      cache.set(key, state);
      return state;
    }).pipe(Effect.provide(context), internalize);
});
