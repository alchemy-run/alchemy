/**
 * Tests that exercise the example worker fixture end-to-end:
 *
 * 1. `POST /sign` mints a presigned PUT URL with Content-Type pinned
 *    into `X-Amz-SignedHeaders`.
 * 2. `GET /file/:key` mints a presigned GET URL with `host` only.
 * 3. The example's `Stack` composes correctly with
 *    `PresignedUrlBinding`.
 *
 * These tests run in-process against the signing logic — no live
 * Cloudflare deploy required. They serve as the canonical
 * verification of the example.
 */

import * as Cloudflare from "@/Cloudflare";
import {
  R2_PRESIGN_ACCESS_KEY_ID_BINDING,
  R2_PRESIGN_ACCOUNT_ID_BINDING,
  R2_PRESIGN_BUCKET_NAME_BINDING,
  R2_PRESIGN_SECRET_ACCESS_KEY_BINDING,
} from "@/Cloudflare/R2/R2PresignAuth.ts";
import { describe, expect, it } from "alchemy-test";
import {
  presignWorkerHandler,
  type PresignEnv,
} from "./fixtures-presign/presign-worker.ts";

const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

const buildEnv = (
  bucketName: string,
  overrides: Partial<PresignEnv> = {},
): PresignEnv => ({
  [R2_PRESIGN_ACCESS_KEY_ID_BINDING]: ACCESS_KEY_ID,
  [R2_PRESIGN_SECRET_ACCESS_KEY_BINDING]: {
    get: () => Promise.resolve(SECRET_ACCESS_KEY),
  },
  [R2_PRESIGN_ACCOUNT_ID_BINDING]: ACCOUNT_ID,
  [R2_PRESIGN_BUCKET_NAME_BINDING]: bucketName,
  ...overrides,
});

describe("Cloudflare.R2.PresignedUrl example worker", () => {
  it("POST /sign returns a presigned PUT URL with Content-Type pinned", async () => {
    const env = buildEnv("cloudflare-r2-presigned-upload-media");
    const request = new Request("http://x/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "uploads/photo.png",
        contentType: "image/png",
      }),
    });

    const response = await presignWorkerHandler(request, env);
    expect(response.status).toBe(200);

    const { url } = (await response.json()) as { url: string };
    const parsed = new URL(url);
    expect(parsed.origin).toBe(
      `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    );
    expect(parsed.pathname).toBe(
      "/cloudflare-r2-presigned-upload-media/uploads/photo.png",
    );
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-type;host",
    );
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(parsed.searchParams.get("X-Amz-Credential")).toMatch(
      new RegExp(`^${ACCESS_KEY_ID}/\\d{8}/auto/s3/aws4_request$`),
    );
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("GET /file/:key returns a presigned GET URL with host-only signed headers", async () => {
    const env = buildEnv("cloudflare-r2-presigned-upload-media");
    const request = new Request(
      "http://x/file/" + encodeURIComponent("uploads/photo.png"),
      { method: "GET" },
    );

    const response = await presignWorkerHandler(request, env);
    expect(response.status).toBe(200);

    const { url } = (await response.json()) as { url: string };
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(
      "/cloudflare-r2-presigned-upload-media/uploads/photo.png",
    );
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("rejects unknown routes with 404", async () => {
    const env = buildEnv("cloudflare-r2-presigned-upload-media");
    const request = new Request("http://x/unknown", { method: "GET" });
    const response = await presignWorkerHandler(request, env);
    expect(response.status).toBe(404);
  });

  it("URL-encodes keys segment by segment", async () => {
    const env = buildEnv("cloudflare-r2-presigned-upload-media");
    const request = new Request(
      "http://x/file/" + encodeURIComponent("a/b c.txt"),
      { method: "GET" },
    );
    const response = await presignWorkerHandler(request, env);
    const { url } = (await response.json()) as { url: string };
    expect(new URL(url).pathname).toBe(
      "/cloudflare-r2-presigned-upload-media/a/b%20c.txt",
    );
  });

  it("two consecutive requests produce different signatures (datetime-driven)", async () => {
    const env = buildEnv("cloudflare-r2-presigned-upload-media");
    const body = JSON.stringify({
      key: "uploads/photo.png",
      contentType: "image/png",
    });
    const makeRequest = () =>
      new Request("http://x/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

    const a = await presignWorkerHandler(makeRequest(), env);
    // 1s pause to ensure the SigV4 timestamp flips (aws4fetch rounds
    // to the nearest second).
    await new Promise((r) => setTimeout(r, 1100));
    const b = await presignWorkerHandler(makeRequest(), env);

    const { url: ua } = (await a.json()) as { url: string };
    const { url: ub } = (await b.json()) as { url: string };
    const sigA = new URL(ua).searchParams.get("X-Amz-Signature");
    const sigB = new URL(ub).searchParams.get("X-Amz-Signature");
    expect(sigA).not.toBeNull();
    expect(sigB).not.toBeNull();
    // Datetime moved; signature should differ.
    expect(sigA).not.toBe(sigB);
  });
});

describe("Cloudflare.R2.PresignedUrl binding export contract", () => {
  it("Cloudflare.R2 re-exports PresignedUrl + PresignedUrlBinding", () => {
    expect(Cloudflare.R2.PresignedUrl).toBeDefined();
    expect(Cloudflare.R2.PresignedUrlBinding).toBeDefined();
    expect(Cloudflare.R2.PresignedUrlHttp).toBeDefined();
    expect(Cloudflare.R2.PresignedUrlLocal).toBeDefined();
  });

  it("PresignedUrl tag carries the Cloudflare.R2.PresignedUrl identifier", () => {
    expect(Cloudflare.R2.PresignedUrl.key).toBe("Cloudflare.R2.PresignedUrl");
  });
});
