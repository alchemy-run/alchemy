import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { Command, Flag } from "effect/unstable/cli";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { Profile, withProfileOverride } from "../../Auth/Profile.ts";
import { Stage } from "../../Stage.ts";
import * as State from "../../State/index.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  envFile,
  importStack,
  instrumentCommand,
  profile,
  script,
  stage,
} from "./_shared.ts";

const loginConfigure = Flag.boolean("configure").pipe(
  Flag.withDescription(
    "Run the provider's interactive configure step before logging in",
  ),
  Flag.withDefault(false),
);

export const loginCommand = Command.make(
  "login",
  {
    main: script,
    envFile,
    stage,
    profile,
    configure: loginConfigure,
  },
  instrumentCommand(
    "login",
    (a: {
      main: string;
      stage: string;
      profile: string;
      configure: boolean;
    }) => ({
      "alchemy.stage": a.stage,
      "alchemy.profile": a.profile,
      "alchemy.main": a.main,
      "alchemy.configure": a.configure,
    }),
  )(
    Effect.fnUntraced(function* ({ main, stage, envFile, profile, configure }) {
      const stackEffect = yield* importStack(main);

      const authProviders: AuthProviders["Service"] = {};

      const services = Layer.mergeAll(
        Layer.succeed(AuthProviders, authProviders),
        ConfigProvider.layer(
          withProfileOverride(yield* loadConfigProvider(envFile), profile),
        ),
        Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        Layer.succeed(Stage, stage),
        State.localState(),
      );

      yield* Effect.gen(function* () {
        const profiles = yield* Profile;
        yield* Effect.catchCause(stackEffect, (cause) =>
          Console.warn(
            `Ignoring error while building stack for login (likely due to missing or broken credentials):\n${Cause.pretty(cause)}`,
          ),
        );

        const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
        const providers = Object.values(authProviders);

        if (providers.length === 0) {
          yield* Console.log(
            "No AuthProviders registered. Make sure the stack's providers() layer includes AuthProviderLayer entries.",
          );
          return;
        }

        yield* Effect.forEach(
          providers,
          (provider) =>
            Effect.gen(function* () {
              const existing = yield* profiles.getProfile(profile);
              const stored = existing?.[provider.name];

              let cfg: { method: string };
              if (configure || stored == null) {
                cfg = yield* provider.configure(profile, { ci });
                yield* profiles.setProfile(profile, {
                  ...existing,
                  [provider.name]: cfg,
                });
              } else {
                cfg = stored;
              }

              yield* provider.login(profile, cfg);
              yield* provider.prettyPrint(profile, cfg);
            }),
          { discard: true },
        );
      }).pipe(Effect.provide(services));
    }),
  ),
);
