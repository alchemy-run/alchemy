import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Command from "effect/unstable/cli/Command";

import { Stage } from "../../Stage.ts";
import * as State from "../../State/index.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import { tail } from "../../Tail.ts";
import {
  envFile,
  importStack,
  instrumentCommand,
  parseResourceFilter,
  profile,
  resourceFilter,
  script,
  stage,
} from "./_shared.ts";

export const tailCommand = Command.make(
  "tail",
  {
    main: script,
    envFile,
    stage,
    profile,
    filter: resourceFilter,
  },
  instrumentCommand(
    "tail",
    (a: { main: string; stage: string; profile: string }) => ({
      "alchemy.stage": a.stage,
      "alchemy.profile": a.profile,
      "alchemy.main": a.main,
    }),
  )(
    Effect.fnUntraced(function* ({ main, stage, envFile, profile, filter }) {
      const stackEffect = yield* importStack(main);

      const services = Layer.mergeAll(
        ConfigProvider.layer(
          withProfileOverride(yield* loadConfigProvider(envFile), profile),
        ),
        Layer.succeed(AuthProviders, {}),
        Layer.succeed(Stage, stage),
        Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        State.localState(),
      );

      yield* Effect.gen(function* () {
        const stack = yield* stackEffect;
        yield* tail(stack, parseResourceFilter(filter)).pipe(
          Effect.provide(stack.services),
        );
      }).pipe(Effect.provide(services));
    }),
  ),
);
