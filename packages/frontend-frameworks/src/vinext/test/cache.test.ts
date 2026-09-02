import { describe, expect, it } from "vitest";
import { redisAdapter } from "../cache/redis.ts";
import { s3Adapter } from "../cache/s3.ts";
import {
  keySpace,
  readEnvString,
  restoreArrayBuffers,
  serializeForJSON,
  validateCacheEntry,
  validateTag,
} from "../cache/shared.ts";

describe("vinext cache adapters", () => {
  it("redisAdapter points at the runtime factory and is JSON-serializable", () => {
    const descriptor = redisAdapter({ urlEnv: "REDIS_URL", appPrefix: "app" });
    expect(descriptor.adapter).toMatch(/redis-runtime\.js$/);
    expect(descriptor.options).toEqual({
      urlEnv: "REDIS_URL",
      appPrefix: "app",
    });
    expect(JSON.parse(JSON.stringify(descriptor.options))).toEqual(
      descriptor.options,
    );
  });

  it("s3Adapter points at the runtime factory", () => {
    const descriptor = s3Adapter({ bucketEnv: "CACHE_BUCKET_NAME" });
    expect(descriptor.adapter).toMatch(/s3-runtime\.js$/);
    expect(descriptor.options?.bucketEnv).toBe("CACHE_BUCKET_NAME");
  });

  it("round-trips APP_PAGE ArrayBuffers through JSON", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const serialized = serializeForJSON({
      kind: "APP_PAGE",
      html: "<p>ok</p>",
      rscData: bytes,
    }) as Record<string, unknown>;
    expect(typeof serialized.rscData).toBe("string");
    const restored = restoreArrayBuffers(serialized);
    expect(restored?.rscData).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(restored!.rscData as ArrayBuffer)]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("rejects invalid tags and cache entries", () => {
    expect(validateTag("")).toBeNull();
    expect(validateTag("ok")).toBe("ok");
    expect(validateTag("a:b")).toBeNull();
    expect(validateCacheEntry({ lastModified: 1, tags: [] })).toBeNull();
    expect(
      validateCacheEntry({
        lastModified: 1,
        tags: [],
        revalidateAt: null,
        expireAt: null,
        value: null,
      }),
    ).not.toBeNull();
  });

  it("namespaces entry and tag keys", () => {
    const keys = keySpace("site");
    expect(keys.entryKey("abc")).toBe("site:cache:abc");
    expect(keys.tagKey("posts")).toBe("site:__tag:posts");
  });

  it("reads env strings from the bag then process.env", () => {
    expect(readEnvString({ REDIS_URL: "redis://bag" }, "REDIS_URL")).toBe(
      "redis://bag",
    );
    expect(readEnvString({ REDIS_URL: "" }, "REDIS_URL")).toBe(
      process.env.REDIS_URL || undefined,
    );
    expect(readEnvString(undefined, "VINEXT_MISSING_ENV_KEY")).toBeUndefined();
  });
});
