import * as NodeCrypto from "node:crypto";
import { AuthError } from "alchemy/Auth/AuthProvider";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";

export interface ServiceAccountKey {
  readonly type?: string;
  readonly project_id?: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

/**
 * The `authorized_user` credential `gcloud auth application-default login`
 * writes to `application_default_credentials.json`.
 */
export interface AuthorizedUserCredentials {
  readonly type: "authorized_user";
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
  readonly quota_project_id?: string;
}

/**
 * Google rejected a refresh token: the user signed out, revoked access, or
 * their organization requires them to sign in again.
 */
export class InvalidGrant extends Data.TaggedError("GCP::InvalidGrant")<{
  readonly message: string;
}> {}

export interface MintedToken {
  readonly accessToken: Redacted.Redacted<string>;
  readonly expirationMs: number;
  readonly project?: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const signJwt = (sa: ServiceAccountKey, nowMs: number): string => {
  const now = Math.floor(nowMs / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: sa.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: sa.token_uri ?? TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = NodeCrypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(sa.private_key, "base64url")}`;
};

/**
 * Exchange a service-account JSON key for an OAuth2 access token.
 * Distilled GCP only accepts a bearer token, so Alchemy mints and refreshes
 * it here.
 */
export const mintAccessToken = (sa: ServiceAccountKey): Effect.Effect<MintedToken, AuthError> =>
  Effect.gen(function* () {
    const issuedAt = yield* Clock.currentTimeMillis;
    const jwt = yield* Effect.try({
      try: () => signJwt(sa, issuedAt),
      catch: (cause) =>
        AuthError.make({
          message: "Failed to sign Google service-account JWT",
          cause,
        }),
    });
    const minted = yield* exchangeToken(
      {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      },
      issuedAt,
    ).pipe(
      Effect.catchTag("GCP::InvalidGrant", (e) =>
        Effect.fail(AuthError.make({ message: e.message })),
      ),
    );
    return { ...minted, project: sa.project_id };
  });

/**
 * Exchange the refresh token in a user's application-default credentials
 * for an OAuth2 access token.
 */
export const refreshUserAccessToken = (
  user: AuthorizedUserCredentials,
): Effect.Effect<MintedToken, AuthError | InvalidGrant> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((issuedAt) =>
      exchangeToken(
        {
          grant_type: "refresh_token",
          client_id: user.client_id,
          client_secret: user.client_secret,
          refresh_token: user.refresh_token,
        },
        issuedAt,
      ),
    ),
    Effect.map((minted) => ({ ...minted, project: user.quota_project_id })),
  );

const exchangeToken = (
  params: Record<string, string>,
  issuedAt: number,
): Effect.Effect<Omit<MintedToken, "project">, AuthError | InvalidGrant> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const tokenResponse = yield* http
      .execute(HttpClientRequest.post(TOKEN_URL).pipe(HttpClientRequest.bodyUrlParams(params)))
      .pipe(
        Effect.mapError((cause) =>
          AuthError.make({
            message: "Failed to mint Google access token",
            cause,
          }),
        ),
      );
    const body = yield* tokenResponse.json.pipe(
      Effect.mapError((cause) =>
        AuthError.make({
          message: "Google token response was not JSON",
          cause,
        }),
      ),
    );
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error, error_description } = body as { error: unknown; error_description?: unknown };
      const message = `Google token endpoint returned ${String(error)}${typeof error_description === "string" ? `: ${error_description}` : ""}`;
      return yield* error === "invalid_grant"
        ? new InvalidGrant({ message })
        : AuthError.make({ message });
    }
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { access_token?: unknown }).access_token !== "string"
    ) {
      return yield* AuthError.make({
        message: `Google token endpoint returned no access_token: ${JSON.stringify(body)}`,
      });
    }
    const expiresIn =
      typeof (body as { expires_in?: unknown }).expires_in === "number"
        ? (body as { expires_in: number }).expires_in
        : 3600;
    return {
      accessToken: Redacted.make((body as { access_token: string }).access_token),
      expirationMs: issuedAt + expiresIn * 1000,
    };
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const parseServiceAccountKey = (raw: string): Effect.Effect<ServiceAccountKey, AuthError> =>
  Effect.try({
    try: () => {
      const parsed = JSON.parse(raw) as ServiceAccountKey;
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error("JSON is missing client_email or private_key");
      }
      return parsed;
    },
    catch: (cause) =>
      AuthError.make({
        message: "Invalid Google service-account JSON",
        cause,
      }),
  });
