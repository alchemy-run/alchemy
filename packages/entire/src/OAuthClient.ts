import { makeOAuthClient } from "alchemy/Auth/OAuthFlow";

export { OAuthCredentials, OAuthError, type DeviceAuthorization } from "alchemy/Auth/OAuthFlow";

/**
 * The Entire CLI's public OAuth client (no secret). Entire issues no
 * long-lived API keys; `entire login` and Alchemy both authorize this client
 * with the RFC 8628 device flow.
 */
export const OAUTH_CLIENT_ID = "entire-cli";

/**
 * Scopes the Entire CLI requests: `cli` for the API surface, and
 * `offline_access` so the server mints a refresh token.
 */
export const OAUTH_SCOPES = ["cli", "offline_access"];

/**
 * The US login server. `https://auth.entire.io` redirects every OAuth call
 * here with a 307; calling it directly keeps the device verification URL on
 * the same host as the endpoint that issued it.
 */
export const OAUTH_ISSUER = "https://us.auth.entire.io";

export const OAUTH_ENDPOINTS = {
  deviceAuthorization: `${OAUTH_ISSUER}/device_authorization`,
  token: `${OAUTH_ISSUER}/oauth/token`,
  revoke: `${OAUTH_ISSUER}/revoke`,
};

const client = makeOAuthClient({
  clientId: OAUTH_CLIENT_ID,
  endpoints: OAUTH_ENDPOINTS,
  auth: { kind: "pkce" },
});

export const { deviceAuthorize, deviceToken, refresh, revoke, usesCurrentClient } = client;
