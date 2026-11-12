import { makeClientCredentials } from "@distilled.cloud/starburst-galaxy/Credentials";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
  type StoredValues,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";

export const STARBURST_GALAXY_AUTH_PROVIDER_NAME = "StarburstGalaxy";

/** The account domain, e.g. `yourco.galaxy.starburst.io`. */
export const STARBURST_GALAXY_DOMAIN_ENV = "STARBURST_GALAXY_DOMAIN";
/** The client ID of a Galaxy service account's API client. */
export const STARBURST_GALAXY_CLIENT_ID_ENV = "STARBURST_GALAXY_CLIENT_ID";
/** The client secret of that API client. */
export const STARBURST_GALAXY_CLIENT_SECRET_ENV = "STARBURST_GALAXY_CLIENT_SECRET";

export type StarburstGalaxyAuthConfig = StoredAuthConfig;

/**
 * A Galaxy API client's OAuth client credentials. They are exchanged for a
 * ten-minute access token on first use and again shortly before it expires,
 * by the distilled SDK's token cache.
 */
export interface StarburstGalaxyResolvedCredentials {
  readonly domain: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly source: { readonly type: StarburstGalaxyAuthConfig["method"] | "env" };
}

const readEnvironment = Effect.gen(function* () {
  const domain = yield* getEnv(STARBURST_GALAXY_DOMAIN_ENV);
  const clientId = yield* getEnv(STARBURST_GALAXY_CLIENT_ID_ENV);
  const clientSecret = yield* getEnvRedacted(STARBURST_GALAXY_CLIENT_SECRET_ENV);
  if (!domain || !clientId || !clientSecret) {
    return yield* AuthError.make({
      message: `Starburst Galaxy CI credentials not found. Set ${STARBURST_GALAXY_DOMAIN_ENV}, ${STARBURST_GALAXY_CLIENT_ID_ENV} and ${STARBURST_GALAXY_CLIENT_SECRET_ENV}.`,
    });
  }
  return {
    domain,
    clientId,
    clientSecret,
    source: { type: "env" as const },
  } satisfies StarburstGalaxyResolvedCredentials;
});

/**
 * Exchange the entered client credentials once before storing them, so a
 * mistyped domain or a revoked client fails at `alchemy profile edit`, not
 * at the first deploy. The exchange is the SDK's own token request.
 */
const verify = (values: StoredValues) =>
  Effect.gen(function* () {
    const resolve = yield* makeClientCredentials({
      domain: storedValueText(values.domain) ?? "",
      clientId: storedValueText(values.clientId) ?? "",
      clientSecret: storedSecret(values.clientSecret) ?? Redacted.make(""),
    });
    yield* resolve;
    return values;
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((cause) =>
      AuthError.make({
        message: `Starburst Galaxy rejected the client credentials: ${cause.message}`,
        cause,
      }),
    ),
  );

const starburstGalaxyAuth = makeStoredAuthProvider<StarburstGalaxyResolvedCredentials>({
  provider: STARBURST_GALAXY_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "domain",
      label: "Starburst Galaxy account domain",
      description: "The host you sign in at, e.g. yourco.galaxy.starburst.io.",
      placeholder: "yourco.galaxy.starburst.io",
    },
    {
      name: "clientId",
      label: "Starburst Galaxy API client ID",
      description: "Galaxy → Settings → API access → create a client for a service account.",
    },
    {
      name: "clientSecret",
      label: "Starburst Galaxy API client secret",
      secret: true,
    },
  ],
  complete: verify,
  toResolved: (values, source) => ({
    domain: storedValueText(values.domain) ?? "",
    clientId: storedValueText(values.clientId) ?? "",
    clientSecret: storedSecret(values.clientSecret) ?? Redacted.make(""),
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: STARBURST_GALAXY_DOMAIN_ENV,
      required: true,
      description: "Account domain, e.g. yourco.galaxy.starburst.io.",
    },
    {
      name: STARBURST_GALAXY_CLIENT_ID_ENV,
      required: true,
      description: "Client ID of a Galaxy API client.",
    },
    {
      name: STARBURST_GALAXY_CLIENT_SECRET_ENV,
      required: true,
      secret: true,
      description: "Client secret of that API client.",
    },
  ],
});

/**
 * Layer that registers the Starburst Galaxy {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Included in
 * `StarburstGalaxy.providers()` so `alchemy profile edit` can configure it.
 */
export const StarburstGalaxyAuth = starburstGalaxyAuth.layer;

/** Schema of the stored client-credential values. */
export const StarburstGalaxyStoredCredentials = starburstGalaxyAuth.storedSchema;
export type StarburstGalaxyStoredCredentials = typeof StarburstGalaxyStoredCredentials.Type;
