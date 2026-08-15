/**
 * Pure unit tests pinning the DISTILLED multipart/mixed parser the queue
 * receive path rides (`@distilled.cloud/vercel` data-protocol) — no cloud
 * access. The live protocol is pinned by `Queues.test.ts`.
 */
import {
  parseMultipartBoundary,
  parseMultipartMixed,
} from "@distilled.cloud/vercel";
import { expect, it } from "alchemy-test";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

it("parseMultipartBoundary extracts quoted and unquoted boundaries", () => {
  expect(parseMultipartBoundary("multipart/mixed; boundary=abc123")).toEqual(
    "abc123",
  );
  expect(parseMultipartBoundary('multipart/mixed; boundary="abc 123"')).toEqual(
    "abc 123",
  );
  expect(
    parseMultipartBoundary("multipart/mixed;boundary=x;charset=utf-8"),
  ).toEqual("x");
  expect(parseMultipartBoundary("application/json")).toEqual(undefined);
  expect(parseMultipartBoundary(undefined)).toEqual(undefined);
});

it("parseMultipartMixed parses a two-part body with Vqs headers", () => {
  const boundary = "vqs-test-boundary";
  const body = [
    `--${boundary}`,
    "Vqs-Message-Id: m-1",
    "Vqs-Receipt-Handle: rh-1",
    "Vqs-Timestamp: 2026-08-13T00:00:00.000Z",
    "Vqs-Delivery-Count: 2",
    "Content-Type: application/json",
    "",
    '{"hello":"world"}',
    `--${boundary}`,
    "Vqs-Message-Id: m-2",
    "Vqs-Receipt-Handle: rh-2",
    "Vqs-Timestamp: 2026-08-13T00:00:01.000Z",
    "Vqs-Delivery-Count: 1",
    "Content-Type: application/json",
    "",
    '{"n":2}',
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const parts = parseMultipartMixed(textEncoder.encode(body), boundary);
  expect(parts).toHaveLength(2);
  expect(parts[0]!.headers["vqs-message-id"]).toEqual("m-1");
  expect(parts[0]!.headers["vqs-receipt-handle"]).toEqual("rh-1");
  expect(parts[0]!.headers["vqs-delivery-count"]).toEqual("2");
  expect(parts[0]!.headers["content-type"]).toEqual("application/json");
  expect(textDecoder.decode(parts[0]!.payload)).toEqual('{"hello":"world"}');
  expect(parts[1]!.headers["vqs-message-id"]).toEqual("m-2");
  expect(textDecoder.decode(parts[1]!.payload)).toEqual('{"n":2}');
});

it("parseMultipartMixed handles a preamble and an empty body", () => {
  const boundary = "b";
  const withPreamble = [
    "ignored preamble",
    `--${boundary}`,
    "Vqs-Message-Id: m-1",
    "",
    "payload-bytes",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const parts = parseMultipartMixed(textEncoder.encode(withPreamble), boundary);
  expect(parts).toHaveLength(1);
  expect(textDecoder.decode(parts[0]!.payload)).toEqual("payload-bytes");

  expect(parseMultipartMixed(textEncoder.encode(""), boundary)).toHaveLength(0);
  expect(
    parseMultipartMixed(textEncoder.encode(`--${boundary}--\r\n`), boundary),
  ).toHaveLength(0);
});

it("parseMultipartMixed preserves multi-line JSON payload bytes verbatim", () => {
  const boundary = "b2";
  const payload = '{\r\n  "nested": "line\\r\\nbreaks"\r\n}';
  const body = `--${boundary}\r\nContent-Type: application/json\r\nVqs-Message-Id: m\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
  const parts = parseMultipartMixed(textEncoder.encode(body), boundary);
  expect(parts).toHaveLength(1);
  expect(textDecoder.decode(parts[0]!.payload)).toEqual(payload);
});
