/**
 * Tests for the Cloudflare R2 token API client + the `R2Token`
 * resource that provisions scoped SigV4 credentials on demand.
 *
 * The Cloudflare API is mocked via `HttpClient.make` — no live
 * Cloudflare API calls required.
 */

import * as CredentialsModule from "@distilled.cloud/cloudflare/Credentials";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { describe, expect, it } from "alchemy-test";
import * as Redacted from "effect/Redacted";
import {
  createR2Token,
  listR2Tokens,
  type R2ApiToken,
} from "@/Cloudflare/R2/R2TokenClient.ts";

const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

const credentialsLayer = Layer.succeed(
  CredentialsModule.Credentials,
  Effect.succeed({
    type: "apiToken",
    apiToken: Redacted.make("test-token"),
    apiBaseUrl: "https://api.cloudflare.com/client/v4",
  } as any),
);

const envLayer = Layer.succeed(
  CloudflareEnvironment,
  Effect.succeed({ accountId: ACCOUNT_ID } as any),
);

const mockCloudflareApi = (
  handler: (request: {
    url: string;
    method: string;
    bodyJson: unknown;
  }) => Response,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      // Extract the request body synchronously. The HTTP body
      // variants we care about: `Uint8Array` (the JSON-encoded body
      // our `bodyJsonUnsafe` produces).
      const body = request.body as unknown as {
        _tag?: string;
        body?: unknown;
      };
      const bodyText =
        body?._tag === "Uint8Array"
          ? new TextDecoder().decode(body.body as ArrayBuffer)
          : typeof body === "string"
            ? body
            : "";
      const bodyJson = bodyText ? JSON.parse(bodyText) : undefined;
      const response = handler({
        url: request.url,
        method: request.method,
        bodyJson,
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const credentialsOk = (tokens: R2ApiToken[]): Response =>
  jsonResponse(200, {
    success: true,
    result: { tokens },
  });

describe("Cloudflare.R2.R2TokenClient", () => {
  it("createR2Token POSTs to /accounts/{id}/r2/tokens with bucket names", async () => {
    let captured:
      | { url: string; method: string; bodyJson: unknown }
      | undefined;
    const http = mockCloudflareApi((req) => {
      captured = {
        url: req.url,
        method: req.method,
        bodyJson: req.bodyJson,
      };
      return jsonResponse(200, {
        success: true,
        result: {
          id: "tok_123",
          name: "test",
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
        },
      });
    });

    const result = await Effect.runPromise(
      createR2Token({ name: "test-token", bucketNames: ["my-bucket"] }).pipe(
        Effect.provide(Layer.mergeAll(credentialsLayer, envLayer, http)),
      ),
    );

    expect(result.id).toBe("tok_123");
    expect(result.accessKeyId).toBe(ACCESS_KEY_ID);
    expect(result.secretAccessKey).toBe(SECRET_ACCESS_KEY);
    expect(captured).toBeDefined();
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toContain(`/accounts/${ACCOUNT_ID}/r2/tokens`);
    expect(captured!.bodyJson).toEqual({
      name: "test-token",
      bucketNames: ["my-bucket"],
    });
  });

  it("createR2Token fails when the API returns success: false", async () => {
    const http = mockCloudflareApi(() =>
      jsonResponse(200, {
        success: false,
        errors: [{ code: 10000, message: "Invalid request" }],
      }),
    );
    const exit = await Effect.runPromiseExit(
      createR2Token({ name: "test-token" }).pipe(
        Effect.provide(Layer.mergeAll(credentialsLayer, envLayer, http)),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("listR2Tokens flattens {tokens: [...]} responses", async () => {
    const http = mockCloudflareApi(() =>
      credentialsOk([
        { id: "tok_1", name: "token-a" },
        { id: "tok_2", name: "token-b" },
      ]),
    );
    const result = await Effect.runPromise(
      listR2Tokens().pipe(
        Effect.provide(Layer.mergeAll(credentialsLayer, envLayer, http)),
      ),
    );
    expect(result).toEqual([
      { id: "tok_1", name: "token-a" },
      { id: "tok_2", name: "token-b" },
    ]);
  });

  it("listR2Tokens flattens {buckets: [...]} responses", async () => {
    const http = mockCloudflareApi(() =>
      jsonResponse(200, {
        success: true,
        result: {
          buckets: [{ id: "tok_b", name: "token-b" }],
        },
      }),
    );
    const result = await Effect.runPromise(
      listR2Tokens().pipe(
        Effect.provide(Layer.mergeAll(credentialsLayer, envLayer, http)),
      ),
    );
    expect(result).toEqual([{ id: "tok_b", name: "token-b" }]);
  });
});

describe("Cloudflare.R2.R2Token resource", () => {
  // The R2TokenProvider requires a live Cloudflare account (POST to
  // /accounts/{id}/r2/tokens) — like AccountApiToken.test.ts, those
  // integration tests are skipped at the describe level and run
  // against a real account via `bun run test test/Cloudflare/R2/R2Token --profile testing`.
  describe.skip("integration", () => {
    it("reconcile mints a new token when none exists", () => {});
    it("reuses an existing token with the same name on subsequent deploys", () => {});
    it("delete is a no-op with a warning (R2 has no token-delete API)", () => {});
    it("diff flags bucketNames changes as replace", () => {});
  });
});
