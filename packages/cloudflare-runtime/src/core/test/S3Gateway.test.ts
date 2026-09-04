/**
 * HTTP-contract test for the dev S3 gateway: drives the exact request
 * shapes geesefs/tigrisfs issues (path-style, V2 lists, ranged GETs,
 * CopyObject renames, multipart with staged parts) with plain `fetch`
 * — no FUSE, no docker — and asserts the S3 XML/headers the client
 * parses. The FUSE end-to-end (a real tigrisfs mount inside a dev
 * container) lives in alchemy's `FuseMount.local.test.ts`.
 */
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { S3Gateway, S3GatewayLive } from "../S3Gateway.ts";
import {
  decodeS3BucketAlias,
  encodeS3BucketAlias,
} from "../S3GatewayProtocol.shared.ts";
import { localRuntimeLayer } from "./helpers/runtime.ts";

// a local (`dev:`) bucket id, addressed through its colon-free alias —
// the same shape FuseMountTigrisfs passes to tigrisfs in dev
const BUCKET = encodeS3BucketAlias("dev:s3-gateway-test");

const TestLayer = S3GatewayLive.pipe(Layer.provideMerge(localRuntimeLayer));

layer(TestLayer, { timeout: 120_000 })("S3Gateway", (it) => {
  const base = Effect.gen(function* () {
    const gateway = yield* S3Gateway;
    return yield* gateway.url;
  });

  const request = (
    path: string,
    init?: RequestInit,
  ): Effect.Effect<Response, never, S3Gateway> =>
    base.pipe(
      Effect.flatMap((url) =>
        Effect.promise(() => fetch(new URL(path, url), init)),
      ),
    );

  it("bucket alias round-trips local ids", () => {
    expect(decodeS3BucketAlias(BUCKET)).toBe("dev:s3-gateway-test");
    expect(BUCKET).not.toContain(":");
    expect(decodeS3BucketAlias("real-bucket")).toBe("real-bucket");
  });

  it.effect("HeadBucket answers 200", () =>
    Effect.gen(function* () {
      const res = yield* request(`/${BUCKET}`, { method: "HEAD" });
      expect(res.status).toBe(200);
    }),
  );

  it.effect("put → head → get round-trip with metadata", () =>
    Effect.gen(function* () {
      const put = yield* request(`/${BUCKET}/greetings/hello.txt`, {
        method: "PUT",
        headers: {
          "content-type": "text/plain",
          "x-amz-meta-owner": "alchemy",
        },
        body: "hello through s3",
      });
      expect(put.status).toBe(200);
      expect(put.headers.get("etag")).toMatch(/^".+"$/);

      const head = yield* request(`/${BUCKET}/greetings/hello.txt`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("16");
      expect(head.headers.get("content-type")).toBe("text/plain");
      expect(head.headers.get("x-amz-meta-owner")).toBe("alchemy");
      expect(head.headers.get("etag")).toBe(put.headers.get("etag"));

      const get = yield* request(`/${BUCKET}/greetings/hello.txt`);
      expect(get.status).toBe(200);
      expect(yield* Effect.promise(() => get.text())).toBe("hello through s3");
    }),
  );

  it.effect("a missing object is NoSuchKey / bodyless head 404", () =>
    Effect.gen(function* () {
      const head = yield* request(`/${BUCKET}/nope.txt`, { method: "HEAD" });
      expect(head.status).toBe(404);
      const get = yield* request(`/${BUCKET}/nope.txt`);
      expect(get.status).toBe(404);
      expect(yield* Effect.promise(() => get.text())).toContain("NoSuchKey");
    }),
  );

  it.effect("ranged reads answer 206 with Content-Range", () =>
    Effect.gen(function* () {
      yield* request(`/${BUCKET}/range.bin`, {
        method: "PUT",
        body: "0123456789",
      });
      const middle = yield* request(`/${BUCKET}/range.bin`, {
        headers: { range: "bytes=2-5" },
      });
      expect(middle.status).toBe(206);
      expect(yield* Effect.promise(() => middle.text())).toBe("2345");
      expect(middle.headers.get("content-range")).toBe("bytes 2-5/10");

      const tail = yield* request(`/${BUCKET}/range.bin`, {
        headers: { range: "bytes=7-" },
      });
      expect(yield* Effect.promise(() => tail.text())).toBe("789");

      const suffix = yield* request(`/${BUCKET}/range.bin`, {
        headers: { range: "bytes=-3" },
      });
      expect(yield* Effect.promise(() => suffix.text())).toBe("789");
    }),
  );

  it.effect("ListObjectsV2 with prefix + delimiter", () =>
    Effect.gen(function* () {
      for (const key of ["list/a.txt", "list/b.txt", "list/dir/c.txt"]) {
        yield* request(`/${BUCKET}/${key}`, { method: "PUT", body: key });
      }
      const res = yield* request(
        `/${BUCKET}?list-type=2&prefix=${encodeURIComponent("list/")}&delimiter=${encodeURIComponent("/")}`,
      );
      expect(res.status).toBe(200);
      const xml = yield* Effect.promise(() => res.text());
      expect(xml).toContain("<Key>list/a.txt</Key>");
      expect(xml).toContain("<Key>list/b.txt</Key>");
      expect(xml).not.toContain("<Key>list/dir/c.txt</Key>");
      expect(xml).toContain("<CommonPrefixes><Prefix>list/dir/</Prefix>");
      expect(xml).toContain("<IsTruncated>false</IsTruncated>");
      expect(xml).toMatch(/<ETag>"[0-9a-f]+"<\/ETag>/);
    }),
  );

  it.effect("V2 pagination hands back a working continuation token", () =>
    Effect.gen(function* () {
      for (const key of ["page/1", "page/2", "page/3"]) {
        yield* request(`/${BUCKET}/${key}`, { method: "PUT", body: key });
      }
      const first = yield* request(
        `/${BUCKET}?list-type=2&prefix=${encodeURIComponent("page/")}&max-keys=2`,
      );
      const firstXml = yield* Effect.promise(() => first.text());
      expect(firstXml).toContain("<IsTruncated>true</IsTruncated>");
      const token = firstXml.match(
        /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/,
      )?.[1];
      expect(token).toBeDefined();

      const second = yield* request(
        `/${BUCKET}?list-type=2&prefix=${encodeURIComponent("page/")}&max-keys=2&continuation-token=${encodeURIComponent(token!)}`,
      );
      const secondXml = yield* Effect.promise(() => second.text());
      expect(secondXml).toContain("<Key>page/3</Key>");
      expect(secondXml).toContain("<IsTruncated>false</IsTruncated>");
    }),
  );

  it.effect("CopyObject copies content and metadata (rename shape)", () =>
    Effect.gen(function* () {
      yield* request(`/${BUCKET}/copy/src.txt`, {
        method: "PUT",
        headers: {
          "content-type": "text/plain",
          "x-amz-meta-kind": "source",
        },
        body: "copy me",
      });
      const copy = yield* request(`/${BUCKET}/copy/dst.txt`, {
        method: "PUT",
        headers: {
          "x-amz-copy-source": `/${BUCKET}/copy/src.txt`,
        },
      });
      expect(copy.status).toBe(200);
      const xml = yield* Effect.promise(() => copy.text());
      expect(xml).toContain("<CopyObjectResult>");
      expect(xml).toMatch(/<ETag>"[0-9a-f]+"<\/ETag>/);

      const dst = yield* request(`/${BUCKET}/copy/dst.txt`);
      expect(yield* Effect.promise(() => dst.text())).toBe("copy me");
      expect(dst.headers.get("x-amz-meta-kind")).toBe("source");
      expect(dst.headers.get("content-type")).toBe("text/plain");
    }),
  );

  it.effect("DeleteObject and batch DeleteObjects", () =>
    Effect.gen(function* () {
      for (const key of ["del/one", "del/two", "del/three"]) {
        yield* request(`/${BUCKET}/${key}`, { method: "PUT", body: key });
      }
      const single = yield* request(`/${BUCKET}/del/one`, {
        method: "DELETE",
      });
      expect(single.status).toBe(204);

      const batch = yield* request(`/${BUCKET}?delete`, {
        method: "POST",
        body:
          `<Delete>` +
          `<Object><Key>del/two</Key></Object>` +
          `<Object><Key>del/three</Key></Object>` +
          `</Delete>`,
      });
      expect(batch.status).toBe(200);
      expect(yield* Effect.promise(() => batch.text())).toContain(
        "<Deleted><Key>del/two</Key></Deleted>",
      );

      for (const key of ["del/one", "del/two", "del/three"]) {
        const head = yield* request(`/${BUCKET}/${key}`, { method: "HEAD" });
        expect(head.status).toBe(404);
      }
    }),
  );

  it.effect("multipart: initiate → parts → complete assembles the object", () =>
    Effect.gen(function* () {
      const initiate = yield* request(`/${BUCKET}/multi/big.bin?uploads`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
      });
      expect(initiate.status).toBe(200);
      const uploadId = (yield* Effect.promise(() => initiate.text())).match(
        /<UploadId>([^<]+)<\/UploadId>/,
      )?.[1];
      expect(uploadId).toBeDefined();

      const partOne = yield* request(
        `/${BUCKET}/multi/big.bin?partNumber=1&uploadId=${uploadId}`,
        { method: "PUT", body: "first-half-" },
      );
      expect(partOne.status).toBe(200);
      const etagOne = partOne.headers.get("etag")!;
      const partTwo = yield* request(
        `/${BUCKET}/multi/big.bin?partNumber=2&uploadId=${uploadId}`,
        { method: "PUT", body: "second-half" },
      );
      const etagTwo = partTwo.headers.get("etag")!;

      const complete = yield* request(
        `/${BUCKET}/multi/big.bin?uploadId=${uploadId}`,
        {
          method: "POST",
          body:
            `<CompleteMultipartUpload>` +
            `<Part><PartNumber>1</PartNumber><ETag>${etagOne}</ETag></Part>` +
            `<Part><PartNumber>2</PartNumber><ETag>${etagTwo}</ETag></Part>` +
            `</CompleteMultipartUpload>`,
        },
      );
      expect(complete.status).toBe(200);
      expect(yield* Effect.promise(() => complete.text())).toContain(
        "<CompleteMultipartUploadResult>",
      );

      const assembled = yield* request(`/${BUCKET}/multi/big.bin`);
      expect(yield* Effect.promise(() => assembled.text())).toBe(
        "first-half-second-half",
      );
      expect(assembled.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
    }),
  );

  it.effect("multipart: abort discards the upload", () =>
    Effect.gen(function* () {
      const initiate = yield* request(`/${BUCKET}/multi/aborted?uploads`, {
        method: "POST",
      });
      const uploadId = (yield* Effect.promise(() => initiate.text())).match(
        /<UploadId>([^<]+)<\/UploadId>/,
      )?.[1];
      yield* request(
        `/${BUCKET}/multi/aborted?partNumber=1&uploadId=${uploadId}`,
        { method: "PUT", body: "junk" },
      );
      const abort = yield* request(
        `/${BUCKET}/multi/aborted?uploadId=${uploadId}`,
        { method: "DELETE" },
      );
      expect(abort.status).toBe(204);
      const head = yield* request(`/${BUCKET}/multi/aborted`, {
        method: "HEAD",
      });
      expect(head.status).toBe(404);
    }),
  );

  it.effect("UploadPartCopy stages a ranged copy as a part", () =>
    Effect.gen(function* () {
      yield* request(`/${BUCKET}/partcopy/source`, {
        method: "PUT",
        body: "abcdefghij",
      });
      const initiate = yield* request(`/${BUCKET}/partcopy/target?uploads`, {
        method: "POST",
      });
      const uploadId = (yield* Effect.promise(() => initiate.text())).match(
        /<UploadId>([^<]+)<\/UploadId>/,
      )?.[1];

      const copy = yield* request(
        `/${BUCKET}/partcopy/target?partNumber=1&uploadId=${uploadId}`,
        {
          method: "PUT",
          headers: {
            "x-amz-copy-source": `/${BUCKET}/partcopy/source`,
            "x-amz-copy-source-range": "bytes=0-4",
          },
        },
      );
      expect(copy.status).toBe(200);
      const copyXml = yield* Effect.promise(() => copy.text());
      expect(copyXml).toContain("<CopyPartResult>");
      const etag = copyXml.match(/<ETag>([^<]+)<\/ETag>/)?.[1];

      yield* request(`/${BUCKET}/partcopy/target?uploadId=${uploadId}`, {
        method: "POST",
        body:
          `<CompleteMultipartUpload>` +
          `<Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part>` +
          `</CompleteMultipartUpload>`,
      });
      const target = yield* request(`/${BUCKET}/partcopy/target`);
      expect(yield* Effect.promise(() => target.text())).toBe("abcde");
    }),
  );

  it.effect("keys with special characters survive path encoding", () =>
    Effect.gen(function* () {
      const key = "spaced dir/file (v2)+plus.txt";
      const encoded = key
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      yield* request(`/${BUCKET}/${encoded}`, {
        method: "PUT",
        body: "special",
      });
      const get = yield* request(`/${BUCKET}/${encoded}`);
      expect(yield* Effect.promise(() => get.text())).toBe("special");
    }),
  );
});
