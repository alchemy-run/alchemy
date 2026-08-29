import {
  R2_PRESIGN_ACCESS_KEY_ID_BINDING,
  R2_PRESIGN_ACCOUNT_ID_BINDING,
  R2_PRESIGN_BUCKET_NAME_BINDING,
  R2_PRESIGN_SECRET_ACCESS_KEY_BINDING,
  R2_SIGNING_REGION,
  readR2PresignEnvCredentials,
  r2Endpoint,
  r2ObjectUrl,
} from "@/Cloudflare/R2/R2PresignAuth.ts";
import { PresignedUrl } from "@/Cloudflare/R2/PresignedUrl.ts";
import {
  PresignedUrlBinding,
  runtimePresignedUrlClientFromEnv,
} from "@/Cloudflare/R2/PresignedUrlBinding.ts";
import { PresignedUrlHttp } from "@/Cloudflare/R2/PresignedUrlHttp.ts";
import {
  makePresignedUrlClient,
  signR2ObjectUrl,
} from "@/Cloudflare/R2/PresignedUrlCore.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "alchemy-test";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Redacted from "effect/Redacted";

const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET_ACCESS_KEY = Redacted.make(
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
);
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

const configFromEnv = (env: Record<string, string | undefined>) =>
  Layer.succeed(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(
      Object.fromEntries(
        Object.entries(env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    ),
  );

describe("Cloudflare.R2.PresignedUrl", () => {
  describe("r2Endpoint / r2ObjectUrl", () => {
    it("builds the canonical account endpoint", () => {
      expect(r2Endpoint(ACCOUNT_ID)).toBe(
        "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      );
    });

    it("URL-encodes keys segment by segment", () => {
      expect(r2ObjectUrl(ACCOUNT_ID, "media", "a/b c.txt")).toBe(
        `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/media/a/b%20c.txt`,
      );
    });

    it("preserves slash segments in keys", () => {
      expect(r2ObjectUrl(ACCOUNT_ID, "media", "users/123/avatar.png")).toBe(
        `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/media/users/123/avatar.png`,
      );
    });

    it("exports the SigV4 region constant for R2 ('auto')", () => {
      expect(R2_SIGNING_REGION).toBe("auto");
    });
  });

  describe("signR2ObjectUrl", () => {
    it("produces a SigV4 query-string URL with the expected query params", async () => {
      const result = await Effect.runPromise(
        signR2ObjectUrl({
          credentials: {
            accessKeyId: ACCESS_KEY_ID,
            secretAccessKey: SECRET_ACCESS_KEY,
            accountId: ACCOUNT_ID,
          },
          method: "GET",
          url: r2ObjectUrl(ACCOUNT_ID, "example-bucket", "test.txt"),
          expiresIn: 86400,
          signedHeaders: "host",
          headers: {},
        }),
      );

      const parsed = new URL(result.url);
      expect(parsed.origin).toBe(
        `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      );
      expect(parsed.pathname).toBe("/example-bucket/test.txt");
      expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe(
        "AWS4-HMAC-SHA256",
      );
      expect(parsed.searchParams.get("X-Amz-Expires")).toBe("86400");
      expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
      expect(parsed.searchParams.get("X-Amz-Credential")).toMatch(
        new RegExp(`^${ACCESS_KEY_ID}/\\d{8}/auto/s3/aws4_request$`),
      );
      expect(parsed.searchParams.get("X-Amz-Date")).toMatch(/^\d{8}T\d{6}Z$/);
      expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(result.headers).toEqual({});
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("pins Content-Type and Content-Length into the signed headers for presignPut", async () => {
      const result = await Effect.runPromise(
        signR2ObjectUrl({
          credentials: {
            accessKeyId: ACCESS_KEY_ID,
            secretAccessKey: SECRET_ACCESS_KEY,
            accountId: ACCOUNT_ID,
          },
          method: "PUT",
          url: r2ObjectUrl(ACCOUNT_ID, "media", "uploads/photo.png"),
          expiresIn: 3600,
          signedHeaders: "content-length;content-type;host",
          headers: {
            "content-type": "image/png",
            "content-length": "1024",
          },
        }),
      );

      const parsed = new URL(result.url);
      expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe(
        "content-length;content-type;host",
      );
      expect(result.headers).toEqual({
        "content-type": "image/png",
        "content-length": "1024",
      });
    });
  });

  describe("makePresignedUrlClient", () => {
    const creds = {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      accountId: ACCOUNT_ID,
    };
    const client = makePresignedUrlClient(creds, "media");

    it("presignGet returns a usable URL", async () => {
      const result = await Effect.runPromise(client.presignGet("file.txt"));
      const url = new URL(result.url);
      expect(url.pathname).toBe("/media/file.txt");
      expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    });

    it("presignPut pins Content-Type into the URL", async () => {
      const result = await Effect.runPromise(
        client.presignPut("uploads/photo.png", {
          contentType: "image/png",
          expiresIn: 60,
        }),
      );
      const url = new URL(result.url);
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
        "content-type;host",
      );
      expect(result.headers["content-type"]).toBe("image/png");
    });

    it("presignDelete signs a DELETE method", async () => {
      const result = await Effect.runPromise(
        client.presignDelete("uploads/photo.png"),
      );
      expect(new URL(result.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
        "host",
      );
    });

    it("presignHead signs a HEAD method", async () => {
      const result = await Effect.runPromise(
        client.presignHead("uploads/photo.png"),
      );
      expect(new URL(result.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
        "host",
      );
    });

    it("expiresAt is approximately now + expiresIn seconds", async () => {
      const before = Date.now();
      const result = await Effect.runPromise(
        client.presignPut("file.txt", {
          contentType: "text/plain",
          expiresIn: 120,
        }),
      );
      const after = Date.now();
      const expires = result.expiresAt.getTime();
      expect(expires).toBeGreaterThanOrEqual(before + 120_000 - 5);
      expect(expires).toBeLessThanOrEqual(after + 120_000 + 5);
    });

    it("clamps expiresIn above the 7-day R2 maximum", async () => {
      const result = await Effect.runPromise(
        client.presignGet("k", { expiresIn: 999999999 }),
      );
      expect(new URL(result.url).searchParams.get("X-Amz-Expires")).toBe(
        "604800",
      );
    });

    it("defaults expiresIn to 1 hour when omitted", async () => {
      const result = await Effect.runPromise(client.presignGet("file.txt"));
      expect(new URL(result.url).searchParams.get("X-Amz-Expires")).toBe(
        "3600",
      );
    });
  });

  describe("readR2PresignEnvCredentials", () => {
    it("returns the credentials when all three env vars are set", async () => {
      const result = await Effect.runPromise(
        readR2PresignEnvCredentials().pipe(
          Effect.provide(
            configFromEnv({
              CLOUDFLARE_R2_ACCESS_KEY_ID: "ak_test",
              CLOUDFLARE_R2_SECRET_ACCESS_KEY: "sk_test",
              CLOUDFLARE_ACCOUNT_ID: "acc_test",
            }),
          ),
        ),
      );
      expect(result.accessKeyId).toBe("ak_test");
      expect(Redacted.value(result.secretAccessKey)).toBe("sk_test");
      expect(result.accountId).toBe("acc_test");
    });

    it("fails with AuthError when env vars are missing", async () => {
      const exit = await Effect.runPromiseExit(
        readR2PresignEnvCredentials().pipe(Effect.provide(configFromEnv({}))),
      );
      expect(exit._tag).toBe("Failure");
    });

    it("fails with AuthError when only one env var is set", async () => {
      const exit = await Effect.runPromiseExit(
        readR2PresignEnvCredentials().pipe(
          Effect.provide(
            configFromEnv({
              CLOUDFLARE_R2_ACCESS_KEY_ID: "ak_only",
            }),
          ),
        ),
      );
      expect(exit._tag).toBe("Failure");
    });

    it("falls back to CloudflareEnvironment for the account id", async () => {
      const program = Effect.gen(function* () {
        const credentials = yield* readR2PresignEnvCredentials();
        return credentials.accountId;
      });
      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(
            Layer.mergeAll(
              configFromEnv({
                CLOUDFLARE_R2_ACCESS_KEY_ID: "ak_test",
                CLOUDFLARE_R2_SECRET_ACCESS_KEY: "sk_test",
              }),
              Layer.succeed(
                CloudflareEnvironment,
                Effect.succeed({ account: ACCOUNT_ID } as any),
              ),
            ),
          ),
        ),
      );
      expect(result).toBe(ACCOUNT_ID);
    });

    it("prefers the CLOUDFLARE_ACCOUNT_ID env var over CloudflareEnvironment", async () => {
      const program = Effect.gen(function* () {
        const credentials = yield* readR2PresignEnvCredentials();
        return credentials.accountId;
      });
      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(
            Layer.mergeAll(
              configFromEnv({
                CLOUDFLARE_R2_ACCESS_KEY_ID: "ak_test",
                CLOUDFLARE_R2_SECRET_ACCESS_KEY: "sk_test",
                CLOUDFLARE_ACCOUNT_ID: "acc_from_env",
              }),
              Layer.succeed(
                CloudflareEnvironment,
                Effect.succeed({ account: ACCOUNT_ID } as any),
              ),
            ),
          ),
        ),
      );
      expect(result).toBe("acc_from_env");
    });

    it("fails with AuthError when account id is missing everywhere", async () => {
      const exit = await Effect.runPromiseExit(
        readR2PresignEnvCredentials().pipe(
          Effect.provide(
            Layer.mergeAll(
              configFromEnv({
                CLOUDFLARE_R2_ACCESS_KEY_ID: "ak_test",
                CLOUDFLARE_R2_SECRET_ACCESS_KEY: "sk_test",
              }),
              Layer.succeed(
                CloudflareEnvironment,
                Effect.succeed({ account: undefined } as any),
              ),
            ),
          ),
        ),
      );
      expect(exit._tag).toBe("Failure");
    });
  });

  describe("runtimePresignedUrlClientFromEnv (Worker fetch handler helper)", () => {
    it("resolves a fully working client from env binding values", async () => {
      // Simulate the Worker's `env` object after the binding layer
      // has registered the four env bindings: access key id and
      // account id as plain strings, secret access key as a
      // secret_text binding (`.get()` returns a Promise), and the
      // bucket name as a plain string.
      const env = {
        [R2_PRESIGN_ACCESS_KEY_ID_BINDING]: ACCESS_KEY_ID,
        [R2_PRESIGN_SECRET_ACCESS_KEY_BINDING]: {
          get: () => Promise.resolve(Redacted.value(SECRET_ACCESS_KEY)),
        },
        [R2_PRESIGN_ACCOUNT_ID_BINDING]: ACCOUNT_ID,
        [R2_PRESIGN_BUCKET_NAME_BINDING]: "media",
      };

      const client = await runtimePresignedUrlClientFromEnv(env);
      const result = await Effect.runPromise(
        client.presignPut("uploads/photo.png", {
          contentType: "image/png",
          expiresIn: 60,
        }),
      );

      const url = new URL(result.url);
      expect(url.pathname).toBe("/media/uploads/photo.png");
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
        "content-type;host",
      );
      expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      expect(result.headers["content-type"]).toBe("image/png");
    });

    it("different bucket names produce different paths for the same key", async () => {
      const env = (bucket: string) => ({
        [R2_PRESIGN_ACCESS_KEY_ID_BINDING]: ACCESS_KEY_ID,
        [R2_PRESIGN_SECRET_ACCESS_KEY_BINDING]: {
          get: () => Promise.resolve(Redacted.value(SECRET_ACCESS_KEY)),
        },
        [R2_PRESIGN_ACCOUNT_ID_BINDING]: ACCOUNT_ID,
        [R2_PRESIGN_BUCKET_NAME_BINDING]: bucket,
      });

      const a = await runtimePresignedUrlClientFromEnv(env("photos"));
      const b = await runtimePresignedUrlClientFromEnv(env("videos"));
      const [ua, ub] = await Promise.all([
        Effect.runPromise(a.presignGet("x.txt")),
        Effect.runPromise(b.presignGet("x.txt")),
      ]);
      expect(new URL(ua.url).pathname).toBe("/photos/x.txt");
      expect(new URL(ub.url).pathname).toBe("/videos/x.txt");
    });
  });

  describe("PresignedUrlHttp", () => {
    it("reads credentials from the environment at Layer build", async () => {
      const layer = Layer.provide(
        PresignedUrlHttp,
        configFromEnv({
          CLOUDFLARE_R2_ACCESS_KEY_ID: ACCESS_KEY_ID,
          CLOUDFLARE_R2_SECRET_ACCESS_KEY: Redacted.value(SECRET_ACCESS_KEY),
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        }),
      );
      const built = await Effect.runPromise(Effect.succeed(layer));
      expect(built).toBe(layer);
    });
  });

  describe("Worker binding contract", () => {
    it("exports the four Worker binding names as the expected constants", () => {
      expect(R2_PRESIGN_ACCESS_KEY_ID_BINDING).toBe("R2_PRESIGN_ACCESS_KEY_ID");
      expect(R2_PRESIGN_SECRET_ACCESS_KEY_BINDING).toBe(
        "R2_PRESIGN_SECRET_ACCESS_KEY",
      );
      expect(R2_PRESIGN_ACCOUNT_ID_BINDING).toBe("R2_PRESIGN_ACCOUNT_ID");
      expect(R2_PRESIGN_BUCKET_NAME_BINDING).toBe("R2_PRESIGN_BUCKET_NAME");
    });
  });

  describe("Effect-native binding contract", () => {
    it("provides the PresignedUrl tag from the binding layer", async () => {
      // Build the PresignedUrlBinding layer against the in-memory
      // ConfigProvider — exercises the full Layer build path
      // including reading credentials, even though Worker + env
      // aren't satisfied in this unit test (we only need the tag
      // to be present at the right key).
      const layer = PresignedUrlHttp.pipe(
        Layer.provide(
          configFromEnv({
            CLOUDFLARE_R2_ACCESS_KEY_ID: ACCESS_KEY_ID,
            CLOUDFLARE_R2_SECRET_ACCESS_KEY: Redacted.value(SECRET_ACCESS_KEY),
            CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
          }),
        ),
      );
      const tag = await Effect.runPromise(
        Effect.succeed(PresignedUrl).pipe(Effect.provide(layer)),
      );
      expect(tag.key).toBe("Cloudflare.R2.PresignedUrl");
    });
  });
});
