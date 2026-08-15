import {
  ALL_SCOPES,
  BASIC_SCOPES,
  customOAuthScopeDefaults,
  OAUTH_SCOPE_GROUPS,
  partitionOAuthScopes,
} from "@/Cloudflare/Auth/OAuthScopes.ts";
import {
  authorize,
  refresh,
  revoke,
  type OAuthCredentials,
} from "@/Cloudflare/Auth/OAuthClient.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("Cloudflare public OAuth client", () => {
  it("uses a duplicate-free, colon-free catalog of allowed scopes", () => {
    const scopes = OAUTH_SCOPE_GROUPS.flatMap((group) => group.scopes);

    expect(scopes.length).toBeGreaterThan(0);
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(scopes.every((scope) => !scope.includes(":"))).toBe(true);
  });

  it("partitions stored scopes against the current catalog", () => {
    // Profiles configured against an older OAuth client can hold scopes the
    // current client rejects; login must drop them instead of building an
    // authorize URL that Cloudflare refuses wholesale.
    const { valid, dropped } = partitionOAuthScopes([
      "workers-scripts.write",
      "account:read", // wrangler-era scope id, not in the alchemy catalog
      "zone.read",
    ]);
    expect(valid).toEqual(["workers-scripts.write", "zone.read"]);
    expect(dropped).toEqual(["account:read"]);
  });

  it("keeps the basic template inside the client allowlist", () => {
    expect(BASIC_SCOPES.length).toBeGreaterThan(0);
    expect(BASIC_SCOPES.every((scope) => scope in ALL_SCOPES)).toBe(true);
    expect(BASIC_SCOPES).toContain("memberships.read");
    expect(BASIC_SCOPES).toContain("workers-scripts.write");
    expect(BASIC_SCOPES).toContain("zone.read");
  });

  it("restores valid custom scopes when OAuth is reconfigured", () => {
    expect(
      customOAuthScopeDefaults({
        method: "oauth",
        scopes: ["workers-scripts.write", "account:read", "zone.read"],
        accountId: "account-id",
      }),
    ).toEqual(["workers-scripts.write", "zone.read"]);

    expect(
      customOAuthScopeDefaults({
        method: "stored",
        credentialType: "apiToken",
      }),
    ).toEqual(BASIC_SCOPES);
  });

  it("uses Cloudflare's public-client authorization endpoint with S256 PKCE", () => {
    const authorization = authorize(["workers-scripts.write"]);
    const url = new URL(authorization.url);

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://dash.cloudflare.com/oauth2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe(
      "e7e25ec474419def6ba38d2d2638b122",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://alchemy.run/auth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("preserves rotated credentials and uses standard token revocation", async () => {
    const originalFetch = globalThis.fetch;
    const requests: URLSearchParams[] = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(new URLSearchParams(String(init?.body)));
      return new Response(
        JSON.stringify({
          access_token: "next-access",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const current: OAuthCredentials = {
      type: "oauth",
      clientId: "e7e25ec474419def6ba38d2d2638b122",
      access: "current-access",
      refresh: "current-refresh",
      expires: 0,
      scopes: ["workers-scripts.write"],
    };

    try {
      const next = await Effect.runPromise(refresh(current));
      await Effect.runPromise(revoke(next));

      expect(next.refresh).toBe("current-refresh");
      expect(next.scopes).toEqual(current.scopes);
      expect(next.clientId).toBe(current.clientId);
      expect(requests[0]?.get("grant_type")).toBe("refresh_token");
      expect(requests[0]?.has("redirect_uri")).toBe(false);
      expect(requests[1]?.get("token")).toBe("current-refresh");
      expect(requests[1]?.get("token_type_hint")).toBe("refresh_token");
      expect(requests[1]?.has("refresh_token")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
