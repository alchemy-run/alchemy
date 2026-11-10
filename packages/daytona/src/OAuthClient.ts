import { makeOAuthClient } from "alchemy/Auth/OAuthFlow";

export { OAuthCredentials, OAuthError, type DeviceAuthorization } from "alchemy/Auth/OAuthFlow";

/**
 * The Daytona CLI's public WorkOS client (no secret), published by Daytona's
 * `GET /api/config` under `oidc.cli`. `daytona login` uses the same device
 * flow. A user session can call what an organization API key can't: the
 * organization, role, invitation and API key endpoints.
 */
export const OAUTH_CLIENT_ID = "client_01M392QZWMYD01SA05BPEYQ84V";

export const OAUTH_ENDPOINTS = {
  deviceAuthorization: "https://api.auth.daytona.io/user_management/authorize/device",
  token: "https://api.auth.daytona.io/user_management/authenticate",
};

const client = makeOAuthClient({
  clientId: OAUTH_CLIENT_ID,
  endpoints: OAUTH_ENDPOINTS,
  auth: { kind: "pkce" },
  // WorkOS answers on api.auth.daytona.io but serves the device page on
  // auth.daytona.io.
  verificationHosts: ["auth.daytona.io"],
});

export const { deviceAuthorize, deviceToken, refresh, usesCurrentClient } = client;
