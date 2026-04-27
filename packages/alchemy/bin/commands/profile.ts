import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { Command } from "effect/unstable/cli";

import { AuthProviders } from "../../src/Auth/AuthProvider.ts";
import {
  getProfile,
  readConfig,
  withProfileOverride,
} from "../../src/Auth/Profile.ts";
import { AwsAuth } from "../../src/AWS/AuthProvider.ts";
import { CloudflareAuth } from "../../src/Cloudflare/Auth/AuthProvider.ts";
import { loadConfigProvider } from "../../src/Util/ConfigProvider.ts";
import { fileLogger } from "../../src/Util/FileLogger.ts";

import { envFile, profile } from "./_shared.ts";

const showCommand = Command.make(
  "show",
  { profile, envFile },
  Effect.fnUntraced(function* ({ profile, envFile }) {
    const stored = yield* getProfile(profile);
    if (stored == null) {
      const config = yield* readConfig;
      const names = Object.keys(config.profiles);
      yield* Console.log(`Profile '${profile}' not found.`);
      if (names.length > 0) {
        yield* Console.log(`Available profiles: ${names.sort().join(", ")}`);
      } else {
        yield* Console.log("No profiles configured. Run `alchemy login`.");
      }
      return;
    }

    yield* Console.log(`Profile: ${profile}`);

    const providerNames = Object.keys(stored).sort();
    if (providerNames.length === 0) {
      yield* Console.log("(no providers configured)");
      return;
    }

    const authProviders: AuthProviders["Service"] = {};
    const authRegistry = Layer.succeed(AuthProviders, authProviders);
    const services = Layer.mergeAll(
      authRegistry,
      ConfigProvider.layer(
        withProfileOverride(yield* loadConfigProvider(envFile), profile),
      ),
      Logger.layer([fileLogger("out")]),
      // Building these layers triggers their AuthProviderLayer effect, which
      // registers the provider into the shared `authProviders` registry.
      Layer.provide(Layer.mergeAll(CloudflareAuth, AwsAuth), authRegistry),
    );

    yield* Effect.gen(function* () {
      for (const name of providerNames) {
        const cfg = stored[name]!;
        yield* Console.log("");
        yield* Console.log(`── ${name} ──`);
        const provider = authProviders[name];
        if (provider == null) {
          // Unknown provider — fall back to a JSON dump so the user can still
          // see what's stored even if its module isn't bundled into the CLI.
          yield* Console.log(`method: ${cfg.method}`);
          const { method: _method, ...rest } = cfg as Record<string, unknown> &
            { method: string };
          for (const [k, v] of Object.entries(rest)) {
            yield* Console.log(
              `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
            );
          }
          continue;
        }
        yield* provider.prettyPrint(profile, cfg);
      }
    }).pipe(Effect.provide(services));
  }),
);

export const profileCommand = Command.make("profile", {}).pipe(
  Command.withSubcommands([showCommand]),
);
