import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as Option from "effect/Option";
import { Path } from "effect/Path";
import { Command, Flag } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AuthProviders } from "../../src/Auth/AuthProvider.ts";
import {
  getProfile,
  setProfile,
  withProfileOverride,
} from "../../src/Auth/Profile.ts";
import { dotAlchemy } from "../../src/Config.ts";
import * as Stack from "../../src/Stack.ts";
import { Stage } from "../../src/Stage.ts";
import * as State from "../../src/State/index.ts";
import { loadConfigProvider } from "../../src/Util/ConfigProvider.ts";
import { fileLogger } from "../../src/Util/FileLogger.ts";
import { PlatformServices } from "../../src/Util/PlatformServices.ts";

import { envFile, main, profile, stage } from "./_shared.ts";

const loginConfigure = Flag.boolean("configure").pipe(
  Flag.withDescription(
    "Run the provider's interactive configure step before logging in",
  ),
  Flag.withDefault(false),
);

export const loginCommand = Command.make(
  "login",
  {
    main,
    envFile,
    stage,
    profile,
    configure: loginConfigure,
  },
  Effect.fnUntraced(function* ({
    main,
    stage,
    envFile,
    profile: profileArg,
    configure,
  }: {
    main: string;
    stage: string;
    envFile: Option.Option<string>;
    profile: string | undefined;
    configure: boolean;
  }) {
    const path = yield* Path;
    const module = yield* Effect.promise(
      () => import(path.resolve(process.cwd(), main)),
    );
    const stackEffect = module.default as ReturnType<
      ReturnType<typeof Stack.make>
    >;
    if (!stackEffect) {
      return yield* Effect.die(
        new Error(
          `Main file '${main}' must export a default stack definition (export default defineStack({...}))`,
        ),
      );
    }

    const profile = profileArg ?? "default";
    const authProviders: AuthProviders["Service"] = {};

    const configProvider = withProfileOverride(
      yield* loadConfigProvider(envFile),
      profile,
    );

    const platform = Layer.mergeAll(PlatformServices, FetchHttpClient.layer);

    const rootLogger = Logger.layer([fileLogger("out")]);

    const alchemy = Layer.mergeAll(
      State.LocalState,
      Layer.provideMerge(rootLogger, dotAlchemy),
    );

    yield* Effect.gen(function* () {
      // Build the stack — this triggers each provider's AuthProviderLayer,
      // which registers itself into the shared `authProviders` registry.
      yield* stackEffect;

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
            const existing = yield* getProfile(profile);
            const stored = existing?.[provider.name];

            let cfg: { method: string };
            if (configure || stored == null) {
              cfg = yield* provider.configure(profile, { ci });
              yield* setProfile(profile, {
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
    }).pipe(
      // AuthProviders MUST be provided before the stack module runs so the
      // factory calls inside each provider's layer write into the same
      // registry we read from below.
      Effect.provideService(AuthProviders, authProviders),
      Effect.provide(
        Layer.provideMerge(
          alchemy,
          Layer.mergeAll(platform, Layer.succeed(Stage, stage)),
        ),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.scoped,
    );
  }),
);
