import assert from "node:assert";
import { Credentials } from "../auth.ts";
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

  export type Metadata = {
    id: string;
    name: string;
  };
  export const ALL_SCOPES = {
    "access:read": "",
    "access:write": "",
    "account:read":
      "See your account info such as account details, analytics, and memberships.",
    "agw:read": "",
    "agw:run": "",
    "ai:read": "Read access to Workers AI catalog and assets",
    "ai:write": "See and change Workers AI catalog and assets",
    "aiaudit:read": "",
    "aiaudit:write": "",
    "aig:read": "",
    "aig:write": "",
    "auditlogs:read": "",
    "browser:read": "",
    "browser:write": "",
    "cfone:read": "",
    "cfone:write": "",
    "cloudchamber:write": "Manage Cloudchamber",
    "constellation:write": "",
    "containers:write": "Manage Workers Containers",
    "d1:write": "See and change D1 Databases.",
    "dex:read": "",
    "dex:write": "",
    "dns_analytics:read": "",
    "dns_records:edit": "",
    "dns_records:read": "",
    "dns_settings:read": "",
    "firstpartytags:write": "",
    "lb:edit": "",
    "lb:read": "",
    "logpush:read": "",
    "logpush:write": "",
    "notification:read": "",
    "notification:write": "",
    "pages:read": "Read access to Pages projects, settings, and deployments.",
    "pages:write": "See and change Pages projects, settings, and deployments.",
    "pipelines:read": "Read access to Pipelines configurations and data",
    "pipelines:setup": "Setup access to Pipelines configurations and data",
    "pipelines:write": "See and change Pipelines configurations and data",
    "query_cache:write": "",
    "queues:write": "See and change Queues settings and data",
    "r2_catalog:write": "",
    "radar:read": "",
    "rag:read": "",
    "rag:write": "",
    "secrets_store:read":
      "Read access to secrets + stores within the Secrets Store",
    "secrets_store:write":
      "See and change secrets + stores within the Secrets Store",
    "sso-connector:read": "",
    "sso-connector:write": "",
    "ssl_certs:write": "See and manage mTLS certificates for your account",
    "teams:pii": "",
    "teams:read": "",
    "teams:secure_location": "",
    "teams:write": "",
    "url_scanner:read": "",
    "url_scanner:write": "",
    "user:read":
      "See your user info such as name, email address, and account memberships.",
    "vectorize:write": "",
    "workers:write":
      "See and change Cloudflare Workers data such as zones, KV storage, namespaces, scripts, and routes.",
    "workers_builds:read": "",
    "workers_builds:write": "",
    "workers_kv:write":
      "See and change Cloudflare Workers KV Storage data such as keys and namespaces.",
    "workers_observability:read": "",
    "workers_observability:write": "",
    "workers_observability_telemetry:write": "",
    "workers_routes:write":
      "See and change Cloudflare Workers data such as filters and routes.",
    "workers_scripts:write":
      "See and change Cloudflare Workers scripts, durable objects, subdomains, triggers, and tail data.",
    "workers_tail:read": "See Cloudflare Workers tail and script data.",
    "zone:read": "Grants read level access to account zone.",
    // Not granted yet
    // "connectivity:admin":
    //   "See, change, and bind to Connectivity Directory services, including creating services targeting Cloudflare Tunnel.",
  };
  export const DEFAULT_SCOPES = [
    "account:read",
    "user:read",
    "workers:write",
    "workers_kv:write",
    "workers_routes:write",
    "workers_scripts:write",
    "workers_tail:read",
    "d1:write",
    "pages:write",
    "zone:read",
    "ssl_certs:write",
    "ai:write",
    "queues:write",
    "pipelines:write",
    "secrets_store:write",
    "containers:write",
    "cloudchamber:write",
  ];

  /**
   * Format Cloudflare credentials as headers, refreshing OAuth credentials if expired.
   * Uses `singleFlight` to avoid making multiple concurrent requests to refresh credentials.
   * If the credentials are OAuth, the `profile` is required so we can read and write the updated credentials.
   */
  export const formatHeadersWithRefresh = async (input: {
    profile: string | undefined;
    credentials: Credentials;
  }) => {
    // if the credentials are not expired, return them as is
    if (!Credentials.isOAuthExpired(input.credentials)) {
      return formatHeaders(input.credentials);
    }
    assert(input.profile, "Profile is required for OAuth credentials");
    const credentials = await Credentials.getRefreshed(
      {
        provider: "cloudflare",
        profile: input.profile,
      },
      async (credentials) => {
        const { credentials: refreshed } = await client.refresh(credentials);
        return refreshed;
      },
    );
    return formatHeaders(credentials);
  };

  /**
   * Format Cloudflare credentials as headers.
   */
  export const formatHeaders = (
    credentials: Credentials,
  ): Record<string, string> => {
    switch (credentials.type) {
      case "api-key":
        return {
          "X-Auth-Key": credentials.apiKey,
          "X-Auth-Email": credentials.email,
        };
      case "api-token":
        return { Authorization: `Bearer ${credentials.apiToken}` };
      case "oauth":
        return { Authorization: `Bearer ${credentials.access}` };
    }
  };
}
