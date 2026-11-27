import { createHash } from "node:crypto";
import { describe, expect, it } from "@alchemy.run/test";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import { makeOAuthClient, type OAuthDpopSigner } from "@/Auth/OAuthFlow.ts";

const endpoints = {
  deviceAuthorization: "https://issuer.example/device",
  token: "https://issuer.example/token",
};
const signer = (seen: Array<Parameters<OAuthDpopSigner["sign"]>[0]>): OAuthDpopSigner => ({
  keyThumbprint: "fixture-thumbprint",
  sign: (input) =>
    Effect.sync(() => {
      seen.push(input);
      return `proof-${seen.length}`;
    }),
});
const token = (token_type = "DPoP") =>
  Response.json({
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
    expires_in: 3600,
    token_type,
  });
const fetchStub = (send: (request: Request, init?: RequestInit) => Promise<Response>) =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) => send(new Request(input, init), init),
    { preconnect: () => {} },
  );

describe("DPoP OAuth flows", { tags: ["unit", "local"] }, () => {
  it.effect(
    "signs device and token requests and retries one nonce challenge with a fresh proof",
    () => {
      const seen: Array<Parameters<OAuthDpopSigner["sign"]>[0]> = [];
      let tokens = 0;
      const client = makeOAuthClient({
        clientId: "fixture",
        endpoints,
        auth: { kind: "dpop", signer: signer(seen) },
      });
      const send = fetchStub(async (request, init) => {
        expect(init?.redirect).toBe("manual");
        expect(request.headers.get("DPoP")).toMatch(/^proof-/);
        const body = new URLSearchParams(await request.text());
        if (request.url === endpoints.deviceAuthorization) {
          expect(body.get("dpop_jkt")).toBe("fixture-thumbprint");
          return Response.json({
            device_code: "device",
            user_code: "code",
            verification_uri: "https://issuer.example/verify",
            expires_in: 100,
            interval: 1,
          });
        }
        if (++tokens === 1)
          return Response.json(
            { error: "use_dpop_nonce" },
            { status: 400, headers: { "DPoP-Nonce": "nonce-1" } },
          );
        return token();
      });
      return Effect.gen(function* () {
        const authorization = yield* client.deviceAuthorize(["read"]);
        const credentials = yield* client.deviceToken(authorization);
        expect(credentials.tokenType).toBe("DPoP");
        expect(credentials.keyThumbprint).toBe("fixture-thumbprint");
        expect(seen.map((proof) => proof.nonce)).toEqual([undefined, undefined, "nonce-1"]);
        expect(tokens).toBe(2);
        const mismatch = { ...credentials, keyThumbprint: "different" };
        const error = yield* client.refresh(mismatch).pipe(Effect.flip);
        expect(error._tag).toBe("OAuthInvalidResponse");
        expect(tokens).toBe(2);
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, send));
    },
  );

  it.effect("rejects bearer downgrade and bounds repeated nonce challenges", () => {
    const client = makeOAuthClient({
      clientId: "fixture",
      endpoints,
      auth: { kind: "dpop", signer: signer([]) },
    });
    const authorization = {
      deviceCode: "device",
      userCode: "code",
      verificationUri: "https://issuer.example/verify",
      verificationUriComplete: "https://issuer.example/verify",
      expiresIn: 10,
      interval: 1,
    };
    return Effect.gen(function* () {
      const downgrade = yield* client.deviceToken(authorization).pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          fetchStub(async () => token("Bearer")),
        ),
        Effect.flip,
      );
      expect(downgrade._tag).toBe("OAuthInvalidResponse");
      let calls = 0;
      const error = yield* client.deviceToken(authorization).pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          fetchStub(async () => {
            calls++;
            return Response.json(
              { error: "use_dpop_nonce" },
              { status: 400, headers: { "DPoP-Nonce": "nonce" } },
            );
          }),
        ),
        Effect.flip,
      );
      expect(error._tag).toBe("OAuthError");
      expect(calls).toBe(2);
    });
  });
});

it.effect(
  "DPoP rejects insecure endpoints before sending credentials",
  () => {
    let calls = 0;
    const client = makeOAuthClient({
      clientId: "fixture",
      endpoints: { ...endpoints, deviceAuthorization: "http://issuer.example/device" },
      auth: { kind: "dpop", signer: signer([]) },
    });
    return Effect.gen(function* () {
      const error = yield* client.deviceAuthorize().pipe(Effect.flip);
      expect(error._tag).toBe("OAuthInvalidResponse");
      expect(calls).toBe(0);
    }).pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        fetchStub(async () => {
          calls++;
          return token();
        }),
      ),
    );
  },
  { tags: ["unit"] },
);

const boundCredentials = {
  type: "oauth" as const,
  clientId: "fixture",
  tokenType: "DPoP" as const,
  keyThumbprint: "fixture-thumbprint",
  access: Redacted.make("fixture-access"),
  refresh: Redacted.make("fixture-refresh"),
  expires: 1_000_000,
  scopes: ["read"],
};

it.effect(
  "DPoP refresh preserves binding metadata and handles a nonce challenge",
  () => {
    const proofs: Array<Parameters<OAuthDpopSigner["sign"]>[0]> = [];
    const client = makeOAuthClient({
      clientId: "fixture",
      endpoints,
      auth: { kind: "dpop", signer: signer(proofs) },
    });
    let calls = 0;
    return Effect.gen(function* () {
      const refreshed = yield* client.refresh(boundCredentials);
      expect(refreshed.tokenType).toBe("DPoP");
      expect(refreshed.keyThumbprint).toBe(boundCredentials.keyThumbprint);
      expect(refreshed.scopes).toEqual(["read"]);
      expect(calls).toBe(2);
      expect(proofs.map((proof) => proof.nonce)).toEqual([undefined, "refresh-nonce"]);
    }).pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        fetchStub(async (request) => {
          const form = new URLSearchParams(await request.text());
          expect(form.get("grant_type")).toBe("refresh_token");
          expect(form.get("refresh_token")).toBe("fixture-refresh");
          if (++calls === 1)
            return Response.json(
              { error: "use_dpop_nonce" },
              { status: 400, headers: { "DPoP-Nonce": "refresh-nonce" } },
            );
          return token();
        }),
      ),
    );
  },
  { tags: ["unit"] },
);

it.effect(
  "DPoP browser authorization retains S256 PKCE through exchange",
  () => {
    const client = makeOAuthClient({
      clientId: "fixture",
      endpoints: { ...endpoints, authorize: "https://issuer.example/authorize" },
      redirectUri: "https://client.example/callback",
      localCallbackUri: "http://127.0.0.1:7777/callback",
      auth: { kind: "dpop", signer: signer([]) },
    });
    return Effect.gen(function* () {
      const authorization = yield* client.authorize(["read"]);
      const url = new URL(authorization.url);
      expect(url.searchParams.get("dpop_jkt")).toBe(boundCredentials.keyThumbprint);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.verifier).toBeDefined();
      expect(url.searchParams.get("code_challenge")).toBe(
        createHash("sha256")
          .update(authorization.verifier ?? "")
          .digest("base64url"),
      );
      const result = yield* client.exchange("fixture-code", authorization).pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          fetchStub(async (request) => {
            const form = new URLSearchParams(await request.text());
            expect(form.get("code_verifier")).toBe(authorization.verifier);
            expect(form.get("redirect_uri")).toBe("https://client.example/callback");
            expect(request.headers.get("DPoP")).toBeDefined();
            return token();
          }),
        ),
      );
      expect(result.tokenType).toBe("DPoP");
    }).pipe(Effect.provide(PlatformServices));
  },
  { tags: ["unit"] },
);

for (const mode of ["nonce-success", "repeated-nonce", "redirect", "denied"] as const) {
  it.effect(
    `DPoP revocation handles ${mode} without false success`,
    () => {
      let calls = 0;
      const proofs: Array<Parameters<OAuthDpopSigner["sign"]>[0]> = [];
      const client = makeOAuthClient({
        clientId: "fixture",
        endpoints: { ...endpoints, revoke: "https://issuer.example/revoke" },
        auth: { kind: "dpop", signer: signer(proofs) },
      });
      return Effect.gen(function* () {
        const outcome = yield* Effect.exit(client.revoke(boundCredentials));
        expect(outcome._tag).toBe(mode === "nonce-success" ? "Success" : "Failure");
        expect(calls).toBe(mode === "nonce-success" || mode === "repeated-nonce" ? 2 : 1);
        if (calls === 2)
          expect(proofs.map((proof) => proof.nonce)).toEqual([undefined, "revoke-nonce"]);
      }).pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          fetchStub(async (request, init) => {
            calls++;
            expect(init?.redirect).toBe("manual");
            expect(request.headers.get("DPoP")).toBe(`proof-${calls}`);
            if (mode === "redirect")
              return new Response(null, {
                status: 302,
                headers: { location: "https://other.example/revoke" },
              });
            if (mode === "denied") return new Response(null, { status: 403 });
            if (mode === "repeated-nonce" || calls === 1)
              return Response.json(
                { error: "use_dpop_nonce" },
                { status: 400, headers: { "DPoP-Nonce": "revoke-nonce" } },
              );
            return new Response(null, { status: 200 });
          }),
        ),
      );
    },
    { tags: ["unit"] },
  );
}

it.effect(
  "DPoP refresh rejects a bearer token response",
  () => {
    const client = makeOAuthClient({
      clientId: "fixture",
      endpoints,
      auth: { kind: "dpop", signer: signer([]) },
    });
    return Effect.gen(function* () {
      const error = yield* client.refresh(boundCredentials).pipe(Effect.flip);
      expect(error._tag).toBe("OAuthInvalidResponse");
    }).pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        fetchStub(async () => token("Bearer")),
      ),
    );
  },
  { tags: ["unit"] },
);

it.effect(
  "existing client-secret refresh remains bearer-compatible",
  () => {
    const client = makeOAuthClient({
      clientId: "fixture",
      endpoints,
      auth: { kind: "clientSecret", clientSecret: Redacted.make("client-fixture") },
    });
    const { tokenType: _tokenType, keyThumbprint: _thumbprint, ...legacy } = boundCredentials;
    return Effect.gen(function* () {
      const credentials = yield* client.refresh(legacy);
      expect(credentials.tokenType).toBeUndefined();
      expect(client.dpopSigner).toBeUndefined();
    }).pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        fetchStub(async (request) => {
          expect(request.headers.get("DPoP")).toBeNull();
          expect(new URLSearchParams(await request.text()).get("client_secret")).toBe(
            "client-fixture",
          );
          return token("Bearer");
        }),
      ),
    );
  },
  { tags: ["unit"] },
);
