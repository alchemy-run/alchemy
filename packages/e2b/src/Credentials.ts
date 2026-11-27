import { ConfigError } from "@distilled.cloud/core/errors";
import { apiBaseUrlFor, Credentials, type Config } from "@distilled.cloud/e2b/Credentials";
import { lazyCredentials, orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { E2B_AUTH_PROVIDER_NAME, type E2BResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_DOMAIN,
  type Config as CredentialsConfig,
} from "@distilled.cloud/e2b/Credentials";

/**
 * Checks that an access token comes with a team id. E2B retired the team
 * listing (`GET /teams` answers 410), so the token's default team can no
 * longer be looked up: the team id must be set (`teamId`, `E2B_TEAM_ID`).
 */
export const withTeamId = Effect.fn(function* (config: Config) {
  if (config.accessToken === undefined || (config.teamId ?? "") !== "") return config;
  return yield* new ConfigError({
    message:
      "The E2B access token needs a team id: set teamId (E2B_TEAM_ID). Find it in the E2B dashboard's team settings.",
  });
});

/**
 * Build a `Credentials` layer that resolves E2B credentials via the current
 * Alchemy profile, or directly from environment variables in CI. An access
 * token without a team id fails with a `ConfigError`. A browser login's
 * token is re-resolved (and refreshed) before it expires.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const resolve = yield* lazyCredentials<E2BResolvedCredentials, ConfigError>()(
        E2B_AUTH_PROVIDER_NAME,
        (creds): Config => ({
          ...(creds.apiKey === undefined ? {} : { apiKey: creds.apiKey }),
          ...(creds.accessToken === undefined ? {} : { accessToken: creds.accessToken }),
          ...(creds.teamId === undefined ? {} : { teamId: creds.teamId }),
          domain: creds.domain,
          apiBaseUrl: apiBaseUrlFor(creds.domain),
        }),
        { expiresAt: (creds) => creds.expires },
      );
      return resolve.pipe(
        Effect.flatMap(withTeamId),
        // `Credentials` has no error channel, so a failed resolution dies
        // here; the engine reports it as `CredentialsRequired`.
        orDieCredentialsUnavailable(E2B_AUTH_PROVIDER_NAME),
      );
    }),
  );
