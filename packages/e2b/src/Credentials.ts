import { ConfigError } from "@distilled.cloud/core/errors";
import * as auth from "@distilled.cloud/e2b/auth";
import {
  apiBaseUrlFor,
  Credentials,
  credentials,
  type Config,
} from "@distilled.cloud/e2b/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
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
 * Fills in the team id for an access token that came without one: E2B
 * lists the token's teams, and the default team is the one it acts on.
 */
export const withTeamId = Effect.fn(function* (config: Config) {
  if (config.accessToken === undefined || (config.teamId ?? "") !== "") return config;
  const teams = yield* auth.listTeams({}).pipe(
    Effect.provide(Layer.mergeAll(credentials(config), FetchHttpClient.layer)),
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `Failed to look up the E2B team for the access token: ${cause.message}`,
        }),
    ),
  );
  const team = teams.find((t) => t.isDefault) ?? (teams.length === 1 ? teams[0] : undefined);
  if (team === undefined) {
    return yield* new ConfigError({
      message:
        teams.length === 0
          ? "The E2B access token belongs to no team"
          : `The E2B access token belongs to ${teams.length} teams and none is the default: set teamId (E2B_TEAM_ID)`,
    });
  }
  return { ...config, teamId: team.teamID };
});

/**
 * Build a `Credentials` layer that resolves E2B credentials via the current
 * Alchemy profile, or directly from environment variables in CI. An access
 * token without a team id gets its default team's id. A browser login's
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
      // The team lookup runs once; a failed one is retried on the next call.
      let teamId: string | undefined;
      return Effect.gen(function* () {
        const config = yield* resolve;
        if (teamId !== undefined && (config.teamId ?? "") === "") return { ...config, teamId };
        const withTeam = yield* withTeamId(config);
        teamId = withTeam.teamId;
        return withTeam;
      });
    }),
  );
