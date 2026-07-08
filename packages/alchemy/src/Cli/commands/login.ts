import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import { AlchemyProfile } from "../../Auth/Profile.ts";

import {
  buildStackProviders,
  envFile,
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
      // Build the user's providers() (+ state) layer to capture the auth
      // providers their stack wires up.
      const { authProviders } = yield* buildStackProviders({
        main,
        envFile,
        profile,
      });

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
              cfg = yield* provider.configure(profile, { ci });
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
