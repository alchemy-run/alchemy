import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/convex/Credentials";
import * as management from "@distilled.cloud/convex/management";
import type { ConfigError } from "@distilled.cloud/core/errors";
import { lazyCredentials, orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { CONVEX_AUTH_PROVIDER_NAME, type ConvexResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  fromDeployment,
} from "@distilled.cloud/convex/Credentials";

/** Projects can only be created with a team token, so a project token is refused. */
export class TeamTokenRequired extends Data.TaggedError("TeamTokenRequired")<{
  readonly message: string;
}> {}

export class InvalidTeamId extends Data.TaggedError("InvalidTeamId")<{
  readonly message: string;
}> {}

/**
 * The Convex team every team-scoped call targets. Holds an effect so the team
 * is resolved, and when not configured discovered from the token, on first
 * use, never at layer build.
 */
export class Team extends Context.Service<Team, Effect.Effect<number>>()("Convex.Team") {}

/** The team ID for the current Convex credentials. */
export const team = Effect.gen(function* () {
  return yield* yield* Team;
});

/** Decide which team to use from `GET /token_details` and an optional override. */
export const teamFromDetails = Effect.fn(function* (
  details: management.GetTokenDetailsResponse,
  override?: string,
) {
  if (details.type !== "teamToken") {
    return yield* new TeamTokenRequired({
      message: `Convex: this is a ${details.type}, but managing projects needs a team access token.`,
    });
  }
  if (override !== undefined && override.length > 0) {
    if (!/^\d+$/.test(override)) {
      return yield* new InvalidTeamId({
        message: `Convex: CONVEX_TEAM_ID must be a numeric team ID, got "${override}".`,
      });
    }
    // A team token belongs to one team, so any other ID is a mistake. Taking
    // it would let another team's 404 read as "already deleted".
    if (Number(override) !== details.teamId) {
      return yield* new InvalidTeamId({
        message: `Convex: CONVEX_TEAM_ID is ${override}, but the token belongs to team ${details.teamId}.`,
      });
    }
  }
  return details.teamId;
});

const make = (
  resolve: Effect.Effect<ConvexResolvedCredentials, ConfigError>,
): Effect.Effect<Context.Context<Credentials | Team>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const credentials = Effect.map(resolve, (creds) => ({
      token: creds.accessToken,
      apiBaseUrl: creds.apiBaseUrl,
    }));
    // `Team` is typed as never failing, so a credentials failure dies here;
    // the engine still reports it as `CredentialsRequired`.
    const team = yield* resolve.pipe(
      Effect.orDie,
      Effect.flatMap((creds) =>
        management.getTokenDetails({}).pipe(
          Effect.flatMap((details) => teamFromDetails(details, creds.teamId)),
          Effect.provideService(Credentials, credentials),
          Effect.provideService(HttpClient.HttpClient, http),
          orDieCredentialsUnavailable(CONVEX_AUTH_PROVIDER_NAME),
        ),
      ),
      Effect.cached,
    );
    return Context.make(Credentials, credentials).pipe(Context.add(Team, team));
  });

/**
 * Build Convex `Credentials` and `Team` from an explicit access token. Useful
 * for tests or when the caller already has a token in hand.
 *
 * @example
 * ```ts
 * Effect.provide(Convex.fromToken({ accessToken: "..." }))
 * ```
 */
export const fromToken = (input: {
  accessToken: string | Redacted.Redacted<string>;
  teamId?: string;
  apiBaseUrl?: string;
}) =>
  Effect.succeed<ConvexResolvedCredentials>({
    type: "accessToken",
    accessToken:
      typeof input.accessToken === "string" ? Redacted.make(input.accessToken) : input.accessToken,
    apiBaseUrl: input.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    teamId: input.teamId,
    source: { type: "stored" },
  }).pipe(make, Layer.effectContext);

/**
 * Build Convex `Credentials` and `Team` through the Alchemy AuthProvider:
 * `CONVEX_ACCESS_TOKEN` when present, otherwise the selected profile.
 * Resolution waits for the first API call, so building the provider layers
 * never needs a profile.
 */
export const fromAuthProvider = () =>
  Layer.effectContext(
    lazyCredentials<ConvexResolvedCredentials, ConfigError>()(
      CONVEX_AUTH_PROVIDER_NAME,
      (creds) => creds,
    ).pipe(Effect.flatMap(make)),
  );
