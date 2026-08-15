import * as VercelCredentials from "@distilled.cloud/vercel/Credentials";
import * as vercelTeams from "@distilled.cloud/vercel/teams";
import * as vercelUser from "@distilled.cloud/vercel/user";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { getEnv, getEnvRedacted, retryOnce } from "../Auth/Env.ts";
import { AlchemyProfile } from "../Auth/Profile.ts";
import * as Clank from "../Util/Clank.ts";

export const VERCEL_AUTH_PROVIDER_NAME = "Vercel";

const STORAGE_KEY = "vercel-stored";

const TOKEN_CREATION_URL = "https://vercel.com/account/settings/tokens";

export type VercelAuthConfig = { method: "env" } | { method: "stored" };

export type VercelStoredCredentials = {
  type: "apiToken";
  apiToken: string;
  teamId?: string;
};

export type VercelResolvedCredentials = {
  type: "apiToken";
  apiToken: Redacted.Redacted<string>;
  teamId?: string;
  source: { type: VercelAuthConfig["method"]; details?: string };
};

const options: Array<{
  value: VercelAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variables",
    hint: "VERCEL_TOKEN (or VERCEL_API_TOKEN) + optional VERCEL_TEAM_ID",
  },
  {
    value: "stored",
    label: "API Token",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

/**
 * Provide a temporary in-memory distilled credentials layer so the token can
 * be verified (and teams listed) before anything is persisted.
 */
const withTokenCredentials = <A, E>(
  token: string,
  effect: Effect.Effect<
    A,
    E,
    VercelCredentials.Credentials | HttpClient.HttpClient
  >,
): Effect.Effect<A, E> =>
  Effect.provide(
    effect,
    Layer.mergeAll(
      VercelCredentials.credentials({ token }),
      FetchHttpClient.layer,
    ),
  );

/** Verify the token works by fetching the authenticated user. */
const verifyToken = (token: string) =>
  Effect.gen(function* () {
    const getAuthUser = yield* vercelUser.getAuthUser;
    yield* getAuthUser({});
  }).pipe(
    (e) => withTokenCredentials(token, e),
    Effect.mapError(
      (e) =>
        new AuthError({
          message:
            "Vercel: token verification failed. Check the token and its scope.",
          cause: e,
        }),
    ),
  );

/**
 * List the teams the token can see and prompt for one (Cloudflare
 * `selectAccount` pattern). A full-account token spans every team the user
 * belongs to; a team-scoped token only lists its own team. Returns
 * `undefined` for personal scope (no teams, or the user skipped).
 */
const selectTeam = (token: string) =>
  Effect.gen(function* () {
    const getTeams = yield* vercelTeams.getTeams;
    const response = yield* getTeams({ limit: 100 }).pipe(
      Effect.mapError(
        (e) =>
          new AuthError({ message: "Vercel: failed to list teams", cause: e }),
      ),
    );
    const teams = response.teams;
    if (teams.length === 0) {
      return undefined;
    }
    const selected = yield* Clank.select<string>({
      message: "Select a Vercel team",
      options: [
        {
          value: "",
          label: "Personal account",
          hint: "Enter to skip — personal scope",
        },
        ...teams.map((team) => ({
          value: team.id,
          label: team.name ?? team.slug,
          hint: team.id,
        })),
      ],
    }).pipe(retryOnce);
    return selected.length === 0 ? undefined : selected;
  }).pipe((e) => withTokenCredentials(token, e));

/**
 * Layer that registers the Vercel {@link AuthProvider} into the
 * {@link AuthProviders} registry.
 */
export const VercelAuth = AuthProviderLayer<
  VercelAuthConfig,
  VercelResolvedCredentials
>()(
  VERCEL_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const profiles = yield* AlchemyProfile;
    const store = yield* CredentialsStore;

    const loginStored = Effect.fn(function* (profileName: string) {
      yield* Clank.info(
        `Create a token at ${TOKEN_CREATION_URL} (scope it to your team, or Full Account)`,
      );
      const apiToken = yield* Clank.password({
        message: "Vercel API Token",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      yield* verifyToken(apiToken);
      const teamId = yield* selectTeam(apiToken);

      yield* store.write<VercelStoredCredentials>(profileName, STORAGE_KEY, {
        type: "apiToken",
        apiToken,
        teamId,
      });
      yield* Clank.success("Vercel: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Vercel authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
      Effect.gen(function* () {
        if (ctx.ci) {
          return { method: "env" as const };
        }
        return yield* configureInteractive(profileName);
      }).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    const resolveCredentials = (
      profileName: string,
      config: VercelAuthConfig,
    ): Effect.Effect<VercelResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fn(function* () {
            const apiToken =
              (yield* getEnvRedacted("VERCEL_TOKEN")) ??
              (yield* getEnvRedacted("VERCEL_API_TOKEN"));
            if (!apiToken) {
              return yield* new AuthError({
                message:
                  "Vercel env credentials not found. Set VERCEL_TOKEN (or VERCEL_API_TOKEN).",
              });
            }
            const teamId = yield* getEnv("VERCEL_TEAM_ID");
            return {
              type: "apiToken" as const,
              apiToken,
              teamId,
              source: { type: "env" as const },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store.read<VercelStoredCredentials>(profileName, STORAGE_KEY).pipe(
            Effect.flatMap((creds) =>
              creds == null
                ? Effect.fail(
                    new AuthError({
                      message:
                        "Vercel stored credentials not found. Run: alchemy login --configure",
                    }),
                  )
                : Effect.succeed({
                    type: "apiToken" as const,
                    apiToken: Redacted.make(creds.apiToken),
                    teamId: creds.teamId,
                    source: { type: "stored" as const },
                  }),
            ),
          ),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: VercelAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORAGE_KEY)
            .pipe(
              Effect.andThen(
                Clank.success("Vercel: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: VercelAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            // If VERCEL_TOKEN isn't set, fall through to the interactive picker
            // so the user can switch to `stored` (or be told to set the env
            // var) instead of silently failing later in `read`. The new
            // selection is persisted to the profile so subsequent logins
            // don't re-prompt.
            getEnvRedacted("VERCEL_TOKEN").pipe(
              Effect.flatMap((token) =>
                token
                  ? Effect.void
                  : getEnvRedacted("VERCEL_API_TOKEN").pipe(
                      Effect.flatMap((fallback) =>
                        fallback
                          ? Effect.void
                          : Effect.gen(function* () {
                              const next =
                                yield* configureInteractive(profileName);
                              const existing =
                                yield* profiles.getProfile(profileName);
                              yield* profiles.setProfile(profileName, {
                                ...existing,
                                [VERCEL_AUTH_PROVIDER_NAME]: next,
                              });
                            }),
                      ),
                    ),
              ),
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<VercelStoredCredentials>(profileName, STORAGE_KEY)
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
                ),
              ),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const prettyPrint = (profileName: string, config: VercelAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Effect.all([
            Console.log(`  apiToken: ${displayRedacted(creds.apiToken, 9)}`),
            Console.log(`  team: ${creds.teamId ?? "(personal)"}`),
            Console.log(`  source: ${sourceStr}`),
          ]);
        }),
      );

    return {
      configure: configureCredentials,
      logout,
      login,
      prettyPrint,
      read: resolveCredentials,
    };
  }),
);
