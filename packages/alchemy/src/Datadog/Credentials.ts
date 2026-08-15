import {
  Credentials,
  siteToApiBaseUrl,
} from "@distilled.cloud/datadog/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  DATADOG_AUTH_PROVIDER_NAME,
  type DatadogAuthConfig,
  type DatadogResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  fromKeys,
  DEFAULT_API_BASE_URL,
  DEFAULT_SITE,
  siteToApiBaseUrl,
} from "@distilled.cloud/datadog/Credentials";

/**
 * Build a `Credentials` layer that resolves Datadog credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        DatadogAuthConfig,
        DatadogResolvedCredentials
      >(DATADOG_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as DatadogAuthConfig),
        ),
        Effect.map((creds) => ({
          apiKey: creds.apiKey,
          appKey: creds.appKey,
          apiBaseUrl: siteToApiBaseUrl(creds.site),
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Datadog credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
