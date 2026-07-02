import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Result from "effect/Result";
import { Command, Flag } from "effect/unstable/cli";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { AlchemyProfile, withProfileOverride } from "../../Auth/Profile.ts";
import * as Provider from "../../Provider.ts";
import { Stage } from "../../Stage.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import { Stack } from "../../Stack.ts";
import {
  envFile,
  importStack,
  instrumentCommand,
  printProfile,
  profile,
  script,
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
    profile,
    configure: loginConfigure,
  },
  instrumentCommand(
    "login",
    (a: { main: string; profile: string; configure: boolean }) => ({
      "alchemy.profile": a.profile,
      "alchemy.main": a.main,
      "alchemy.configure": a.configure,
    }),
  )(
    Effect.fn(function* ({ main, envFile, profile, configure }) {
      const stackEffect = yield* importStack(main);

      const authProviders: AuthProviders["Service"] = {};

      const baseLayer = Layer.mergeAll(
        Layer.succeed(AuthProviders, authProviders),
        ConfigProvider.layer(
          withProfileOverride(yield* loadConfigProvider(envFile), profile),
        ),
        Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        Layer.succeed(Stage, "placeholder"),
      );

      // Compile the stack (runs the user's program with a placeholder stage —
      // resource constructors only register nodes, no cloud calls) so we know
      // exactly which resource types it uses. That powers exact-mode provider
      // metadata: providers' configure steps can then suggest exactly the
      // scopes this stack needs. Registers the Auth Providers as a side
      // effect of building the stack's services.
      const compiled = yield* stackEffect.pipe(
        Effect.provide(baseLayer),
        Effect.result,
      );

      let providerMetadata: Provider.StackProviderMetadata | undefined;
      if (Result.isSuccess(compiled)) {
        const stack = compiled.success;
        providerMetadata = Provider.collectProviderMetadata(
          stack.services,
          Object.values(stack.resources).map((r: { Type: string }) => r.Type),
        );
      } else {
        // The stack program failed to compile (e.g. it needs env/config that
        // isn't available before login). Fall back to building just the
        // state + providers layer to capture the Auth Providers; configure
        // steps then use their generic defaults.
        yield* Layer.build(
          (stackEffect.providers ?? Layer.empty).pipe(
            Layer.provideMerge(stackEffect.state ?? Layer.empty),
            Layer.provideMerge(
              Layer.mergeAll(
                baseLayer,
                Layer.succeed(Stack, {
                  actions: {},
                  bindings: {},
                  name: stackEffect.stackName,
                  resources: {},
                  stage: "placeholder",
                }),
              ),
            ),
          ),
        );
      }

      const profiles = yield* AlchemyProfile;

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
            // --configure treats every provider as missing, so configure
            // runs unconditionally and overwrites the stored entry.
            const stored = configure ? undefined : existing?.[provider.name];

            let cfg: { method: string };
            if (stored == null) {
              cfg = yield* provider.configure(profile, {
                ci,
                providerMetadata,
              });
              yield* profiles.setProfile(profile, {
                ...existing,
                [provider.name]: cfg,
              });
            } else {
              cfg = stored;
            }
          }),
        { discard: true },
      );

      // Print the resulting profile using the same renderer as
      // `alchemy profile show`.
      const final = yield* profiles.getProfile(profile);
      if (final != null) {
        yield* Console.log("");
        yield* printProfile(profile, final, authProviders);
      }
    }),
  ),
);
