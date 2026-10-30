import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeS3Client } from "../../../prisma/src/internal/BucketClient.ts";
import { writeBucketOperations } from "../../../prisma/src/WriteBucket.ts";

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
}

interface Reply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined;

/**
 * An `HttpClient` that records each request and answers from `respond`, so the
 * client runs end to end without the network.
 */
const fakeStore = (respond: (request: SentRequest) => Reply) => {
  const sent: SentRequest[] = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const recorded = {
          method: request.method,
          url: url.toString(),
          headers: { ...request.headers },
          body: bodyText(request),
        };
        sent.push(recorded);
        const reply = respond(recorded);
        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.body ?? null, { status: reply.status, headers: reply.headers }),
        );
      }),
    ),
  );
  return { sent, client: makeS3Client(credentials, layer) };
};

const objectHeaders = {
  "content-length": "5",
  etag: '"e2"',
  "last-modified": "Thu, 01 Oct 2026 00:00:00 GMT",
  "content-type": "text/plain",
  "x-amz-meta-owner": "api",
};

const encode = (text: string) => Effect.sync(() => new TextEncoder().encode(text));

describe("Prisma bucket client", { tags: ["unit", "provider:prisma", "local"] }, () => {
  // Expected values were produced by the previous `@distilled.cloud/aws`
  // client for the same credentials, keys and signing time.
  it.effect("presigns GET and PUT URLs exactly as the AWS SDK client did", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIGNING_TIME);
      const { client } = fakeStore(() => ({ status: 500 }));

      expect(yield* client.presign({ method: "GET", key: "reports/2026 q1+final.json" })).toBe(
        "https://t3.storage.dev/user-abc123/reports/2026%20q1%2Bfinal.json?X-Amz-Expires=900&X-Amz-Date=20261030T120000Z&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=tid_testkey%2F20261030%2Fauto%2Fs3%2Faws4_request&X-Amz-SignedHeaders=host&X-Amz-Signature=c149217af584bfcfc9fa5b9fc43dfb3e969467a8485cccaca7363729b17d9176",
      );
      const download = new URL(
        yield* client.presign({
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
        yield* client.presign({
          method: "PUT",
          key: "uploads/avatar.png",
          contentType: "image/png",
        }),
      ).toBe(
        "https://t3.storage.dev/user-abc123/uploads/avatar.png?X-Amz-Expires=900&X-Amz-Date=20261030T120000Z&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=tid_testkey%2F20261030%2Fauto%2Fs3%2Faws4_request&X-Amz-SignedHeaders=content-type%3Bhost&X-Amz-Signature=c47ad65853608828842e71d3eab9baa8ff7a58be50dee00c14a6df9357cbc9de",
      );
      expect(
        yield* client.presign({ method: "PUT", key: "uploads/raw.bin", expiresIn: 3600 }),
      ).toBe(
        "https://t3.storage.dev/user-abc123/uploads/raw.bin?X-Amz-Expires=3600&X-Amz-Date=20261030T120000Z&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=tid_testkey%2F20261030%2Fauto%2Fs3%2Faws4_request&X-Amz-SignedHeaders=host&X-Amz-Signature=36be6ebbc7734c74c9f271df8b9ae0db884475f171e981588ab9e43798eefe6d",
      );
    }),
  );

  it.effect("signs a HEAD exactly as the AWS SDK client did", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIGNING_TIME);
      const store = fakeStore(() => ({ status: 200, headers: objectHeaders }));
      const object = yield* store.client.headObject("a/b c.txt");

      expect(object).toEqual({
        key: "a/b c.txt",
        size: 5,
        etag: "e2",
        lastModified: new Date("2026-10-01T00:00:00.000Z"),
        contentType: "text/plain",
        metadata: { owner: "api" },
      });
      expect(store.sent).toMatchObject([
        {
          method: "HEAD",
          url: "https://t3.storage.dev/user-abc123/a/b%20c.txt",
          headers: {
            authorization:
              "AWS4-HMAC-SHA256 Credential=tid_testkey/20261030/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=78f61c8600ccf2eae3f844f9cf1aacfbfc91eb16bc839bd1045596fa24c21e6c",
            "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            "x-amz-date": "20261030T120000Z",
          },
          body: undefined,
        },
      ]);
    }),
  );

  it.effect("sends a ranged GET and streams the body", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => ({
        status: 206,
        body: "llo",
        headers: { ...objectHeaders, "content-length": "3" },
      }));
      const object = yield* store.client.getObject("a.txt", { range: { offset: 2, length: 3 } });

      expect(store.sent[0]?.headers.range).toBe("bytes=2-4");
      expect(object?.size).toBe(3);
      expect(yield* object?.text() ?? Effect.succeed(undefined)).toBe("llo");
    }),
  );

  it.effect("reads an open-ended range to the end of the object", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => ({ status: 206, body: "lo", headers: objectHeaders }));
      yield* store.client.getObject("a.txt", { range: { offset: 3 } });
      expect(store.sent[0]?.headers.range).toBe("bytes=3-");
    }),
  );

  it.effect("treats a missing key as null and a missing bucket as an error", () =>
    Effect.gen(function* () {
      const missingKey = fakeStore(() => ({
        status: 404,
        body: "<Error><Code>NoSuchKey</Code></Error>",
      }));
      expect(yield* missingKey.client.getObject("gone")).toBeNull();
      expect(yield* missingKey.client.headObject("gone")).toBeNull();
      yield* missingKey.client.deleteObject("gone");

      const headWithoutBody = fakeStore(() => ({ status: 404 }));
      expect(yield* headWithoutBody.client.headObject("gone")).toBeNull();

      const missingBucket = fakeStore(() => ({
        status: 404,
        body: "<Error><Code>NoSuchBucket</Code></Error>",
      }));
      const error = yield* missingBucket.client.getObject("k").pipe(Effect.flip);
      expect(error.message).toBe("GetObject failed with HTTP 404 (NoSuchBucket)");
      expect(error.cause).toMatchObject({ _tag: "NoSuchBucket", status: 404 });
      const deleteError = yield* missingBucket.client.deleteObject("k").pipe(Effect.flip);
      expect(deleteError.message).toBe("DeleteObject failed with HTTP 404 (NoSuchBucket)");
    }),
  );

  it.effect("fails with the store's error code and message on other statuses", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => ({
        status: 403,
        body: "<Error><Code>AccessDenied</Code><Message>Access Denied.</Message></Error>",
      }));
      const error = yield* store.client.putObject("k", "v").pipe(Effect.flip);
      expect(error.message).toBe("PutObject failed with HTTP 403 (AccessDenied): Access Denied.");
      expect(error.cause).toMatchObject({ _tag: "S3ServiceError", code: "AccessDenied" });
      expect(store.sent.length).toBe(1);
    }),
  );

  it.effect("sends PUT headers and signs metadata", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => ({ status: 200, headers: { etag: '"e1"' } }));
      const object = yield* store.client.putObject("k.json", '{"ok":true}', {
        contentType: "application/json",
        cacheControl: "no-cache",
        contentDisposition: "inline",
        contentEncoding: "identity",
        metadata: { owner: "api" },
      });

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
      expect(request?.headers.authorization).toContain(
        "SignedHeaders=cache-control;content-disposition;content-encoding;host;x-amz-content-sha256;x-amz-date;x-amz-meta-owner,",
      );
    }),
  );

  it.effect("defaults the content type by body kind", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => ({ status: 200 }));
      yield* store.client.putObject("s.txt", "hi");
      yield* store.client.putObject("raw.bin", new Uint8Array([1, 2, 3]));

      expect(store.sent[0]?.headers["content-type"]).toBe("text/plain");
      expect(store.sent[1]?.headers["content-type"]).toBe("application/octet-stream");
    }),
  );

  it.effect("buffers a stream body, with or without a length", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => ({ status: 200 }));
      const chunks = [yield* encode("hel"), yield* encode("lo")];
      yield* store.client.putObject("a.txt", Stream.fromIterable(chunks));
      yield* store.client.putObject("b.txt", Stream.fromIterable(chunks), { contentLength: 5 });

      expect(store.sent.map((request) => request.body)).toEqual(["hello", "hello"]);
    }),
  );

  it.effect("lists with ListObjectsV2 parameters and parses the page", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => ({
        status: 200,
        body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>user-abc123</Name><IsTruncated>true</IsTruncated><Contents><Key>p/a &amp; b.txt</Key><LastModified>2026-10-01T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>5</Size></Contents><CommonPrefixes><Prefix>p/dir/</Prefix></CommonPrefixes><NextContinuationToken>tok==</NextContinuationToken></ListBucketResult>`,
      }));
      const page = yield* store.client.listObjectsV2({
        prefix: "p/",
        delimiter: "/",
        limit: 2,
        cursor: "c1",
        startAfter: "p/0",
      });

      expect(store.sent[0]?.url).toBe(
        "https://t3.storage.dev/user-abc123?list-type=2&prefix=p%2F&delimiter=%2F&continuation-token=c1&max-keys=2&start-after=p%2F0",
      );
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
      const store = fakeStore(() => ({
        status: 200,
        body: "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a</Key><Size>1</Size></Contents><Contents><Key>b</Key><Size>2</Size></Contents></ListBucketResult>",
      }));
      const page = yield* store.client.listObjectsV2();

      expect(store.sent[0]?.url).toBe("https://t3.storage.dev/user-abc123?list-type=2");
      expect(page.truncated).toBe(false);
      expect(page.objects.map((object) => object.key)).toEqual(["a", "b"]);
    }),
  );

  it.effect("rejects a list response it cannot trust", () =>
    Effect.gen(function* () {
      const messageFor = (body: string) =>
        fakeStore(() => ({ status: 200, body }))
          .client.listObjectsV2()
          .pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );

      expect(yield* messageFor("<Other/>")).toBe(
        "ListObjectsV2 returned a response that is not a ListBucketResult",
      );
      expect(
        yield* messageFor("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"),
      ).toBe("ListObjectsV2 returned IsTruncated without a NextContinuationToken");
      expect(
        yield* messageFor(
          "<ListBucketResult><Contents><Key>a</Key><Size>x</Size></Contents></ListBucketResult>",
        ),
      ).toBe("ListObjectsV2 returned an invalid Size for a");
    }),
  );

  it.effect("percent-encodes list parameters", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => ({
        status: 200,
        body: "<ListBucketResult></ListBucketResult>",
      }));
      yield* store.client.listObjectsV2({ prefix: "a b+c/" });

      expect(store.sent[0]?.url).toBe(
        "https://t3.storage.dev/user-abc123?list-type=2&prefix=a%20b%2Bc%2F",
      );
    }),
  );

  it.effect("retries a transient failure but not a client error", () =>
    Effect.gen(function* () {
      let calls = 0;
      const flaky = fakeStore(() =>
        ++calls === 1
          ? { status: 503, body: "<Error><Code>SlowDown</Code></Error>" }
          : { status: 200, headers: objectHeaders },
      );
      expect((yield* flaky.client.headObject("k"))?.etag).toBe("e2");
      expect(flaky.sent.length).toBe(2);

      const down = fakeStore(() => ({ status: 503 }));
      yield* down.client.headObject("k").pipe(Effect.flip);
      expect(down.sent.length).toBe(6);
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects keys that cannot be addressed safely", () =>
    Effect.gen(function* () {
      const store = fakeStore(() => ({ status: 200 }));
      for (const key of ["a/../b", "..", "./a", "../other-bucket/x", "bad\uD800"]) {
        const error = yield* store.client.putObject(key, "v").pipe(Effect.flip);
        expect(error._tag).toBe("BucketError");
      }
      expect(store.sent).toEqual([]);
    }),
  );

  it.effect("deletes many keys one request at a time", () =>
    Effect.gen(function* () {
      const store = fakeStore((request) => ({ status: request.url.endsWith("/x") ? 204 : 404 }));
      yield* writeBucketOperations(store.client)
        .delete(["x", "y/z"])
        .pipe(
          Effect.provideService(RuntimeContext, {
            Type: "Test",
            id: "test",
            env: {},
            get: () => Effect.undefined,
            set: (id) => Effect.succeed(id),
          }),
        );

      expect(store.sent.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
        "DELETE https://t3.storage.dev/user-abc123/x",
        "DELETE https://t3.storage.dev/user-abc123/y/z",
      ]);
    }),
  );
});
