import { describe, expect, test } from "bun:test";
import {
  corsHeaders,
  MAX_BYTES,
  objectKey,
  parseUpload,
  UUID,
} from "../src/policy.ts";

describe("upload request policy", () => {
  test("accepts valid metadata at the size limit", () => {
    expect(
      parseUpload({
        filename: "report.txt",
        contentType: "text/plain",
        size: MAX_BYTES,
      }),
    ).toEqual({
      filename: "report.txt",
      contentType: "text/plain",
      size: MAX_BYTES,
    });
  });
  test("rejects empty, oversized, fractional and nonnumeric sizes", () => {
    for (const size of [0, -1, MAX_BYTES + 1, 0.5, "1", null, Infinity]) {
      expect(
        parseUpload({
          filename: "report.txt",
          contentType: "text/plain",
          size,
        }),
      ).toBeUndefined();
    }
  });
  test("rejects malformed metadata", () => {
    for (const value of [
      null,
      [],
      "file",
      {},
      { filename: "x", size: 1 },
      { filename: "\r\n", contentType: "text/plain", size: 1 },
      { filename: "x", contentType: "text/plain\r\nx-header: bad", size: 1 },
    ]) {
      expect(parseUpload(value)).toBeUndefined();
    }
  });
  test("encodes owner path segments and never uses the filename in keys", () => {
    expect(objectKey("user/../../other", "file-id")).toBe(
      "incoming/user%2F..%2F..%2Fother/file-id",
    );
  });
  test("normalizes deployed URLs with trailing slashes", () => {
    expect(
      corsHeaders("https://app.example", "https://app.example/")?.[
        "access-control-allow-origin"
      ],
    ).toBe("https://app.example");
    expect(corsHeaders("null", "not-a-url")).toBeUndefined();
  });
  test("allows explicitly configured wildcard CORS without cookies", () => {
    const headers = corsHeaders("https://app.example", "*");
    expect(headers?.["access-control-allow-origin"]).toBe("*");
    expect(headers?.["access-control-allow-credentials"]).toBeUndefined();
  });
  test("rejects unexpected origins", () => {
    expect(
      corsHeaders("https://attacker.example", "https://app.example"),
    ).toBeUndefined();
    expect(corsHeaders("https://app.example", undefined)).toBeUndefined();
  });
  test("permits the configured browser origin without credentials", () => {
    const headers = corsHeaders("https://app.example", "https://app.example");
    expect(headers?.["access-control-allow-origin"]).toBe(
      "https://app.example",
    );
    expect(headers?.["access-control-allow-credentials"]).toBeUndefined();
    expect(headers?.vary).toBe("Origin");
  });
  test("permits nonbrowser requests but does not manufacture an origin", () => {
    expect(
      corsHeaders(null, "https://app.example")?.["access-control-allow-origin"],
    ).toBeUndefined();
  });
  test("validates download IDs before the uuid query", () => {
    expect(UUID.test("10000000-0000-4000-8000-000000000001")).toBe(true);
    expect(UUID.test("../another-user")).toBe(false);
  });
});
