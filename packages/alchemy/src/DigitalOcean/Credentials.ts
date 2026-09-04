import { ConfigError } from "@distilled.cloud/core/errors";
import {
  Credentials,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/digitalocean/Credentials";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  DIGITALOCEAN_AUTH_PROVIDER_NAME,
  type DigitalOceanAuthConfig,
  type DigitalOceanResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/digitalocean/Credentials";

/**
 * A `Credentials` layer. It reads the token for the active profile through
 * the DigitalOcean auth provider. `ALCHEMY_PROFILE` selects the profile.
 * The default is `default`.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        DigitalOceanAuthConfig,
        DigitalOceanResolvedCredentials
      >(DIGITALOCEAN_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const isCI = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* profile
        .loadOrConfigure(auth, profileName, { ci: isCI })
        .pipe(
          Effect.flatMap((config) =>
            auth.read(profileName, config as DigitalOceanAuthConfig),
          ),
          Effect.map((credentials) => ({
            apiToken: credentials.apiToken,
            apiBaseUrl: DEFAULT_API_BASE_URL,
          })),
          Effect.mapError(
            (cause) =>
              new ConfigError({
                message: `Failed to resolve DigitalOcean credentials for profile '${profileName}': ${String(cause)}`,
              }),
          ),
          Effect.orDie,
          Effect.cached,
        );
    }),
  );
