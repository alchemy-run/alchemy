import assert from "node:assert";
import { Credentials, Profile } from "../auth.ts";
import { singleFlight } from "../util/memoize.ts";
import { OAuthClient } from "../util/oauth-client.ts";

export namespace CloudflareAuth {
  export const client = new OAuthClient({
    clientId: "6d8c2255-0773-45f6-b376-2914632e6f91",
    redirectUri: "http://localhost:9976/auth/callback",
    endpoints: {
      authorize: "https://dash.cloudflare.com/oauth2/authorize",
      token: "https://dash.cloudflare.com/oauth2/token",
      revoke: "https://dash.cloudflare.com/oauth2/revoke",
    },
  });
  export const ALL_SCOPES = [
    "access:read",
    "access:write",
    "account:read",
    "agw:read",
    "agw:run",
    "ai:read",
    "ai:write",
    "aiaudit:read",
    "aiaudit:write",
    "aig:read",
    "aig:write",
    "auditlogs:read",
    "browser:read",
    "browser:write",
    "cfone:read",
    "cfone:write",
    "cloudchamber:write",
    "constellation:write",
    "containers:write",
    "d1:write",
    "dex:read",
    "dex:write",
    "dns_analytics:read",
    "dns_records:edit",
    "dns_records:read",
    "dns_settings:read",
    "firstpartytags:write",
    // "images:read",
    // "images:write",
    "lb:edit",
    "lb:read",
    "logpush:read",
    "logpush:write",
    "notification:read",
    "notification:write",
    "pages:read",
    "pages:write",
    "pipelines:read",
    "pipelines:setup",
    "pipelines:write",
    "query_cache:write",
    "queues:write",
    "r2_catalog:write",
    "radar:read",
    "rag:read",
    "rag:write",
    "secrets_store:read",
    "secrets_store:write",
    "sso-connector:read",
    "sso-connector:write",
    "ssl_certs:write",
    "teams:pii",
    "teams:read",
    "teams:secure_location",
    "teams:write",
    "url_scanner:read",
    "url_scanner:write",
    "user:read",
    "vectorize:write",
    "workers:write",
    "workers_builds:read",
    "workers_builds:write",
    "workers_kv:write",
    "workers_observability:read",
    "workers_observability:write",
    "workers_observability_telemetry:write",
    "workers_routes:write",
    "workers_scripts:write",
    "workers_tail:read",
    "zone:read",
    "offline_access",
  ];

  export const get = singleFlight(
    async (
      profile: string,
      options: { refresh: boolean } = { refresh: false },
    ) => {
      const item = await Profile.get({ provider: "cloudflare", profile });
      if (!item) return null;
      if (options.refresh && Credentials.isOAuthExpired(item.credentials)) {
        item.credentials = await client.refresh(item.credentials);
        await Profile.set({ provider: "cloudflare", profile }, item);
      }
      return item;
    },
  );

  export const toHeaders = (
    credentials: Credentials,
  ): Record<string, string> => {
    switch (credentials.type) {
      case "oauth":
        return { Authorization: `Bearer ${credentials.access}` };
      case "api-key":
        return {
          "X-Auth-Key": credentials.apiKey,
          "X-Auth-Email": credentials.apiEmail,
        };
      case "api-token":
        return { Authorization: `Bearer ${credentials.apiToken}` };
    }
  };

  export const toHeadersWithRefresh = async (
    profile: string | undefined,
    credentials: Credentials,
  ) => {
    if (Credentials.isOAuthExpired(credentials)) {
      assert(profile, "Profile is required");
      const refreshed = await get(profile, { refresh: true });
      assert(refreshed, "Refreshed credentials are required");
      return toHeaders(refreshed.credentials);
    }
    return toHeaders(credentials);
  };
}
