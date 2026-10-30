import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeBucketAccess } from "../../../prisma/src/internal/BucketClient.ts";

const credentials = {
  endpoint: Effect.succeed("https://t3.storage.dev/"),
  bucketName: Effect.succeed("user-abc123"),
  accessKeyId: Effect.succeed("tid_testkey"),
  secretAccessKey: Effect.succeed(Redacted.make("tsec_testsecret")),
};

const SIGNING_TIME = Date.UTC(2026, 9, 30, 12, 0, 0);

interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  streamed: boolean;
}

/**
 * A fetch that records each request and answers from `respond`, so the client
 * runs end to end without the network.
 */
const fakeStore = (respond: (request: Request) => Response) => {
  const sent: SentRequest[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: init?.body == null ? undefined : await new Response(init.body).text(),
      streamed: init?.body instanceof ReadableStream,
    });
    return respond(request);
  }) as typeof globalThis.fetch;
  return {
    sent,
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
  };
};

const signedHeaders = (request: SentRequest) =>
  /SignedHeaders=([^,]+)/.exec(request.headers.authorization ?? "")?.[1];

const objectHeaders = {
  "content-length": "5",
  etag: '"e2"',
  "last-modified": "Thu, 01 Oct 2026 00:00:00 GMT",
  "content-type": "text/plain",
  "x-amz-meta-owner": "api",
};

describe("Prisma bucket client", { tags: ["unit", "provider:prisma", "local"] }, () => {
  // Expected URLs were produced by the previous `@distilled.cloud/aws` client
  // for the same credentials, keys and signing time.
  it.effect("presigns GET and PUT URLs exactly as the AWS SDK client did", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIGNING_TIME);
      const access = makeBucketAccess(credentials);

      expect(yield* access.presign({ method: "GET", key: "reports/2026 q1+final.json" })).toBe(
        "https://t3.storage.dev/user-abc123/reports/2026%20q1%2Bfinal.json?X-Amz-Expires=900&X-Amz-Date=20261030T120000Z&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=tid_testkey%2F20261030%2Fauto%2Fs3%2Faws4_request&X-Amz-SignedHeaders=host&X-Amz-Signature=c149217af584bfcfc9fa5b9fc43dfb3e969467a8485cccaca7363729b17d9176",
      );
      const download = new URL(
        yield* access.presign({
          method: "GET",
          key: "a.txt",
          expiresIn: 60,
          responseContentType: "text/plain",
        }),
      );
      expect(download.searchParams.get("response-content-type")).toBe("text/plain");
      expect(download.searchParams.get("X-Amz-Signature")).toBe(
        "27e8cb04ae2312d8558080cdfa9315645b05cb4bb7cb0e9866b4081663c510db",
      );
      expect(
        yield* access.presign({
          method: "PUT",
          key: "uploads/avatar.png",
          contentType: "image/png",
        }),
      ).toBe(
        "https://t3.storage.dev/user-abc123/uploads/avatar.png?X-Amz-Expires=900&X-Amz-Date=20261030T120000Z&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=tid_testkey%2F20261030%2Fauto%2Fs3%2Faws4_request&X-Amz-SignedHeaders=content-type%3Bhost&X-Amz-Signature=c47ad65853608828842e71d3eab9baa8ff7a58be50dee00c14a6df9357cbc9de",
      );
      expect(
        yield* access.presign({ method: "PUT", key: "uploads/raw.bin", expiresIn: 3600 }),
      ).toBe(
        "https://t3.storage.dev/user-abc123/uploads/raw.bin?X-Amz-Expires=3600&X-Amz-Date=20261030T120000Z&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=tid_testkey%2F20261030%2Fauto%2Fs3%2Faws4_request&X-Amz-SignedHeaders=host&X-Amz-Signature=36be6ebbc7734c74c9f271df8b9ae0db884475f171e981588ab9e43798eefe6d",
      );
    }),
  );

  it.effect("signs a path-style HEAD and reads object metadata from headers", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIGNING_TIME);
      const store = fakeStore(() => new Response(null, { status: 200, headers: objectHeaders }));
      const object = yield* store.run(makeBucketAccess(credentials).headObject("a/b c.txt"));

      expect(object).toEqual({
        key: "a/b c.txt",
        size: 5,
        etag: "e2",
        lastModified: new Date("2026-10-01T00:00:00.000Z"),
        contentType: "text/plain",
        metadata: { owner: "api" },
      });
      const [request] = store.sent;
      expect(request?.method).toBe("HEAD");
      expect(request?.url).toBe("https://t3.storage.dev/user-abc123/a/b%20c.txt");
      expect(request?.headers["x-amz-date"]).toBe("20261030T120000Z");
      expect(request?.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
      expect(request?.headers.authorization).toContain(
        "Credential=tid_testkey/20261030/auto/s3/aws4_request",
      );
      expect(signedHeaders(request!)).toBe("host;x-amz-content-sha256;x-amz-date");
    }),
  );

  it.effect("sends a ranged GET and streams the body", () =>
    Effect.gen(function* () {
      const store = fakeStore(
        () =>
          new Response("llo", {
            status: 206,
            headers: { ...objectHeaders, "content-length": "3" },
          }),
      );
      const object = yield* store.run(
        makeBucketAccess(credentials).getObject("a.txt", { range: { offset: 2, length: 3 } }),
      );

      expect(store.sent[0]?.headers.range).toBe("bytes=2-4");
      expect(object?.size).toBe(3);
      expect(yield* object!.text()).toBe("llo");
    }),
  );

  it.effect("reads an open-ended range to the end of the object", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => new Response("lo", { status: 206, headers: objectHeaders }));
      yield* store.run(makeBucketAccess(credentials).getObject("a.txt", { range: { offset: 3 } }));
      expect(store.sent[0]?.headers.range).toBe("bytes=3-");
    }),
  );

  it.effect("treats a missing key as null and a missing bucket as an error", () =>
    Effect.gen(function* () {
      const access = makeBucketAccess(credentials);
      const missingKey = fakeStore(
        () => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
      );
      expect(yield* missingKey.run(access.getObject("gone"))).toBeNull();
      expect(yield* missingKey.run(access.headObject("gone"))).toBeNull();

      const missingBucket = fakeStore(
        () => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }),
      );
      const error = yield* missingBucket.run(access.getObject("k")).pipe(Effect.flip);
      expect(error._tag).toBe("BucketError");
      expect(error.message).toBe("GetObject failed with HTTP 404 (NoSuchBucket)");
    }),
  );

  it.effect("fails with the store's error code on other statuses", () =>
    Effect.gen(function* () {
      const store = fakeStore(
        () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
      );
      const error = yield* store
        .run(makeBucketAccess(credentials).putObject("k", "v"))
        .pipe(Effect.flip);
      expect(error.message).toBe("PutObject failed with HTTP 403 (AccessDenied)");
    }),
  );

  it.effect("sends PUT headers and signs metadata", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => new Response(null, { status: 200, headers: { etag: '"e1"' } }));
      const object = yield* store.run(
        makeBucketAccess(credentials).putObject("k.json", '{"ok":true}', {
          contentType: "application/json",
          cacheControl: "no-cache",
          contentDisposition: "inline",
          contentEncoding: "identity",
          metadata: { owner: "api" },
        }),
      );

      expect(object).toEqual({
        key: "k.json",
        size: 0,
        etag: "e1",
        lastModified: undefined,
        contentType: "application/json",
        metadata: { owner: "api" },
      });
      const [request] = store.sent;
      expect(request?.method).toBe("PUT");
      expect(request?.url).toBe("https://t3.storage.dev/user-abc123/k.json");
      expect(request?.body).toBe('{"ok":true}');
      expect(request?.headers).toMatchObject({
        "content-type": "application/json",
        "cache-control": "no-cache",
        "content-disposition": "inline",
        "content-encoding": "identity",
        "x-amz-meta-owner": "api",
      });
      expect(signedHeaders(request!)).toBe(
        "cache-control;content-disposition;content-encoding;host;x-amz-content-sha256;x-amz-date;x-amz-meta-owner",
      );
    }),
  );

  it.effect("defaults the content type by body kind", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => new Response(null, { status: 200 }));
      const access = makeBucketAccess(credentials);
      yield* store.run(access.putObject("s.txt", "hi"));
      yield* store.run(access.putObject("raw.bin", new Uint8Array([1, 2, 3])));

      expect(store.sent[0]?.headers["content-type"]).toBe("text/plain");
      expect(store.sent[1]?.headers["content-type"]).toBe("application/octet-stream");
    }),
  );

  it.effect("buffers a stream without a known length", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => new Response(null, { status: 200 }));
      const encoder = new TextEncoder();
      yield* store.run(
        makeBucketAccess(credentials).putObject(
          "stream.txt",
          Stream.make(encoder.encode("hel"), encoder.encode("lo")),
        ),
      );
      expect(store.sent[0]?.streamed).toBe(false);
      expect(store.sent[0]?.body).toBe("hello");
    }),
  );

  it.effect("lists with ListObjectsV2 parameters and parses the page", () =>
    Effect.gen(function* () {
      const store = fakeStore(
        () =>
          new Response(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>user-abc123</Name><IsTruncated>true</IsTruncated><Contents><Key>p/a &amp; b.txt</Key><LastModified>2026-10-01T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>5</Size></Contents><CommonPrefixes><Prefix>p/dir/</Prefix></CommonPrefixes><NextContinuationToken>tok==</NextContinuationToken></ListBucketResult>`,
            { status: 200 },
          ),
      );
      const page = yield* store.run(
        makeBucketAccess(credentials).listObjects({
          prefix: "p/",
          delimiter: "/",
          limit: 2,
          cursor: "c1",
          startAfter: "p/0",
        }),
      );

      const url = new URL(store.sent[0]!.url);
      expect(url.pathname).toBe("/user-abc123");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        "list-type": "2",
        prefix: "p/",
        delimiter: "/",
        "continuation-token": "c1",
        "max-keys": "2",
        "start-after": "p/0",
      });
      expect(page).toEqual({
        objects: [
          {
            key: "p/a & b.txt",
            size: 5,
            etag: "abc",
            lastModified: new Date("2026-10-01T00:00:00.000Z"),
            contentType: undefined,
            metadata: {},
          },
        ],
        delimitedPrefixes: ["p/dir/"],
        truncated: true,
        cursor: "tok==",
      });
    }),
  );

  it.effect("reports the last page as not truncated", () =>
    Effect.gen(function* () {
      const store = fakeStore(
        () =>
          new Response(
            "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a</Key><Size>1</Size></Contents><Contents><Key>b</Key><Size>2</Size></Contents></ListBucketResult>",
            { status: 200 },
          ),
      );
      const page = yield* store.run(makeBucketAccess(credentials).listObjects());

      expect(new URL(store.sent[0]!.url).search).toBe("?list-type=2");
      expect(page.truncated).toBe(false);
      expect(page.objects.map((object) => object.key)).toEqual(["a", "b"]);
    }),
  );

  it.effect("deletes a key and tolerates one that is already gone", () =>
    Effect.gen(function* () {
      const store = fakeStore(
        (request) => new Response(null, { status: request.url.endsWith("/x") ? 204 : 404 }),
      );
      const access = makeBucketAccess(credentials);
      yield* store.run(access.deleteObject("x"));
      yield* store.run(access.deleteObject("y/z"));

      expect(store.sent.map((request) => `${request.method} ${request.url}`)).toEqual([
        "DELETE https://t3.storage.dev/user-abc123/x",
        "DELETE https://t3.storage.dev/user-abc123/y/z",
      ]);
    }),
  );
});
