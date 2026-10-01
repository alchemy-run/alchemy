import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { AuthError } from "../Auth/AuthProvider.ts";

/** Microsoft Entra ID (Azure AD) public-cloud authority. */
export const ENTRA_AUTHORITY = "https://login.microsoftonline.com";

/** OAuth2 scope for Azure Resource Manager (the distilled SDK's API). */
export const ARM_SCOPE = "https://management.azure.com/.default";

/** Refresh a cached token this long before it expires. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface ServicePrincipal {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
}

export interface MintedToken {
  readonly accessToken: Redacted.Redacted<string>;
  readonly expiresAtMs: number;
}

const tokenError = (message: string, cause?: unknown) =>
  new AuthError({ message, cause });

/**
 * Exchange a service principal's client secret for an Azure Resource
 * Manager access token (OAuth2 client-credentials grant). Distilled Azure
 * only accepts a bearer token, so Alchemy mints and refreshes it here.
 */
export const mintAccessToken = (
  sp: ServicePrincipal,
  scope: string = ARM_SCOPE,
): Effect.Effect<MintedToken, AuthError> =>
  Effect.gen(function* () {
    const issuedAt = yield* Clock.currentTimeMillis;
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.post(
          `${ENTRA_AUTHORITY}/${encodeURIComponent(sp.tenantId)}/oauth2/v2.0/token`,
        ).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "client_credentials",
            client_id: sp.clientId,
            client_secret: Redacted.value(sp.clientSecret),
            scope,
          }),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          tokenError(
            "Failed to reach the Microsoft Entra token endpoint",
            cause,
          ),
        ),
      );
    const body = yield* response.json.pipe(
      Effect.mapError((cause) =>
        tokenError("Microsoft Entra token response was not JSON", cause),
      ),
    );
    const record =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
    if (typeof record.access_token !== "string") {
      // `error_description` never echoes the secret.
      const reason =
        typeof record.error_description === "string"
          ? record.error_description
          : typeof record.error === "string"
            ? record.error
            : `HTTP ${response.status}`;
      return yield* tokenError(
        `Microsoft Entra did not issue an access token for client ${sp.clientId}: ${reason}`,
      );
    }
    const expiresIn = Number(record.expires_in ?? 3600) || 3600;
    return {
      accessToken: Redacted.make(record.access_token),
      expiresAtMs: issuedAt + expiresIn * 1000,
    };
  }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * Wrap {@link mintAccessToken} in a cache keyed by tenant + client ID that
 * re-mints shortly before the token expires.
 */
export const makeTokenCache = Effect.gen(function* () {
  const cache = yield* Ref.make<
    { key: string; token: MintedToken } | undefined
  >(undefined);
  return (sp: ServicePrincipal): Effect.Effect<MintedToken, AuthError> =>
    Effect.gen(function* () {
      const key = `${sp.tenantId}/${sp.clientId}`;
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(cache);
      if (
        cached !== undefined &&
        cached.key === key &&
        cached.token.expiresAtMs - now > REFRESH_WINDOW_MS
      ) {
        return cached.token;
      }
      const token = yield* mintAccessToken(sp);
      yield* Ref.set(cache, { key, token });
      return token;
    });
});
