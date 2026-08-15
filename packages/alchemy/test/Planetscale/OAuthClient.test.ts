import {
  OAUTH_CLIENT_ID,
  exchange,
  usesCurrentClient,
} from "@/Planetscale/OAuthClient.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("PlanetScale OAuth client credentials", () => {
  it("maps the token response onto stored credentials", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) =>
      new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          scope: "read write",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const before = Date.now();
      const credentials = await Effect.runPromise(exchange("code"));
      expect(credentials.type).toBe("oauth");
      expect(credentials.clientId).toBe(OAUTH_CLIENT_ID);
      expect(credentials.access).toBe("access");
      expect(credentials.refresh).toBe("refresh");
      expect(credentials.scopes).toEqual(["read", "write"]);
      expect(credentials.expires).toBeGreaterThanOrEqual(
        before + 3_600_000 - 1_000,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("flags credentials issued to a rotated client id as stale", () => {
    expect(usesCurrentClient({ clientId: OAUTH_CLIENT_ID })).toBe(true);
    expect(usesCurrentClient({ clientId: "pscale_app_old" })).toBe(false);
    // Credentials persisted before clientId was stored must read as stale so
    // login falls back to a fresh browser authorization.
    expect(usesCurrentClient({})).toBe(false);
  });
});
