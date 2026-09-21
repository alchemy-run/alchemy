import { makeR2BucketHelpers } from "@/Celld/R2/BucketBinding";
import type {
  BucketValue,
  NativeBucket,
  NativeMultipartUpload,
  NativeObject,
  NativeObjectBody,
  NativeObjects,
  PutOptions,
  R2Error,
  ObjectBody,
  MultipartUpload,
} from "@/Celld/R2/BucketTypes";
import { ReadBucket, type ReadBucketClient } from "@/Celld/R2/ReadBucket";
import { ReadWriteBucket } from "@/Celld/R2/ReadWriteBucket";
import { makeReadWriteBucketClient } from "@/Celld/R2/ReadWriteBucketBinding";
import { WriteBucket, type WriteBucketClient } from "@/Celld/R2/WriteBucket";
import { RuntimeContext } from "@/RuntimeContext";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
export type R2RequestContracts = [
  Assert<
    Equal<Effect.Services<ReturnType<ReadBucketClient["get"]>>, RuntimeContext>
  >,
  Assert<
    Equal<Effect.Services<ReturnType<WriteBucketClient["put"]>>, RuntimeContext>
  >,
  Assert<
    Equal<Effect.Services<ReturnType<ObjectBody["text"]>>, RuntimeContext>
  >,
  Assert<
    Equal<
      Effect.Services<ReturnType<MultipartUpload["uploadPart"]>>,
      RuntimeContext
    >
  >,
  Assert<Equal<Effect.Services<ReadBucketClient["raw"]>, RuntimeContext>>,
  Assert<
    Equal<
      keyof Effect.Success<ReadBucketClient["raw"]>,
      "head" | "get" | "list"
    >
  >,
];

const request = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
  effect.pipe(Effect.provide(RuntimeContext.phantom));
const bytes = (value: BucketValue) =>
  Effect.tryPromise(() =>
    new Response(value as BodyInit | null).arrayBuffer(),
  ).pipe(Effect.map((buffer) => new Uint8Array(buffer)));

const fixture = () => {
  const entries = new Map<
    string,
    { object: NativeObject; bytes: Uint8Array }
  >();
  const calls: { operation: string; options: unknown }[] = [];
  const uploads = new Map<string, Map<number, Uint8Array>>();
  let nextUpload = 0;
  const object = (
    key: string,
    value: Uint8Array,
    options?: PutOptions,
  ): NativeObject => ({
    key,
    version: "version",
    size: value.byteLength,
    etag: "etag",
    httpEtag: '"etag"',
    uploaded: new Date(0),
    httpMetadata:
      options?.httpMetadata instanceof Headers
        ? { contentType: options.httpMetadata.get("content-type") ?? undefined }
        : (options?.httpMetadata ?? {}),
    customMetadata: options?.customMetadata ?? {},
    checksums: { toJSON: () => ({}) },
    storageClass: options?.storageClass ?? "Standard",
    writeHttpMetadata(headers) {
      if (this.httpMetadata.contentType)
        headers.set("content-type", this.httpMetadata.contentType);
    },
  });
  const multipart = (key: string, uploadId: string): NativeMultipartUpload => ({
    key,
    uploadId,
    uploadPart: (partNumber, value) =>
      Effect.runPromise(
        bytes(value).pipe(
          Effect.map((value) => {
            const parts = uploads.get(uploadId);
            if (!parts)
              throw new Error("multipart upload not found on this node");
            parts.set(partNumber, value);
            return { partNumber, etag: "" };
          }),
        ),
      ),
    abort: () =>
      Effect.runPromise(
        Effect.sync(() => {
          if (!uploads.delete(uploadId))
            throw new Error("multipart upload not found on this node");
        }),
      ),
    complete: (parts) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const stored = uploads.get(uploadId);
          if (!stored)
            return yield* Effect.fail(
              new Error("multipart upload not found on this node"),
            );
          const value = yield* Effect.sync(
            () =>
              new Uint8Array(
                parts.flatMap((part) => [...stored.get(part.partNumber)!]),
              ),
          );
          const result = object(key, value);
          entries.set(key, { object: result, bytes: value });
          uploads.delete(uploadId);
          return result;
        }),
      ),
  });
  const native: NativeBucket = {
    head: (key) =>
      Effect.runPromise(Effect.sync(() => entries.get(key)?.object ?? null)),
    get: (key, options) =>
      Effect.runPromise(
        Effect.sync(() => {
          calls.push({ operation: "get", options });
          const entry = entries.get(key);
          if (!entry) return null;
          if (
            options?.onlyIf &&
            !(options.onlyIf instanceof Headers) &&
            options.onlyIf.etagMatches !== undefined &&
            options.onlyIf.etagMatches !== entry.object.etag
          )
            return entry.object;
          const range = options?.range;
          const value =
            range && !(range instanceof Headers)
              ? "suffix" in range
                ? entry.bytes.slice(-range.suffix)
                : entry.bytes.slice(
                    range.offset ?? 0,
                    range.length === undefined
                      ? undefined
                      : (range.offset ?? 0) + range.length,
                  )
              : entry.bytes;
          const response = new Response(value.slice().buffer);
          const body: NativeObjectBody = {
            ...entry.object,
            ...(range && !(range instanceof Headers) ? { range } : {}),
            body: response.body!,
            get bodyUsed() {
              return response.bodyUsed;
            },
            arrayBuffer: () => response.arrayBuffer(),
            bytes: () =>
              Effect.runPromise(
                Effect.tryPromise(() => response.arrayBuffer()).pipe(
                  Effect.map((buffer) => new Uint8Array(buffer)),
                ),
              ),
            text: () => response.text(),
            json: <T>() => response.json() as Promise<T>,
            blob: () => response.blob(),
          };
          return body;
        }),
      ),
    put: (key, value, options) =>
      Effect.runPromise(
        Effect.gen(function* () {
          calls.push({ operation: "put", options });
          if (
            options?.onlyIf &&
            !(options.onlyIf instanceof Headers) &&
            options.onlyIf.etagMatches === "mismatch"
          )
            return null;
          const body = yield* bytes(value);
          const result = object(key, body, options);
          entries.set(key, { object: result, bytes: body });
          return result;
        }),
      ),
    delete: (keys) =>
      Effect.runPromise(
        Effect.sync(() => {
          for (const key of typeof keys === "string" ? [keys] : keys)
            entries.delete(key);
        }),
      ),
    list: (options) =>
      Effect.runPromise(
        Effect.sync((): NativeObjects => {
          calls.push({ operation: "list", options });
          const names = [...entries.keys()]
            .sort()
            .filter(
              (key) =>
                key.startsWith(options?.prefix ?? "") &&
                key > (options?.cursor ?? options?.startAfter ?? ""),
            );
          const page = names.slice(0, options?.limit ?? 1000);
          const objects = page.map((key) => entries.get(key)!.object);
          return page.length < names.length
            ? {
                objects,
                delimitedPrefixes: [],
                truncated: true,
                cursor: page[page.length - 1],
              }
            : { objects, delimitedPrefixes: [], truncated: false };
        }),
      ),
    createMultipartUpload: (key, options) =>
      Effect.runPromise(
        Effect.sync(() => {
          calls.push({ operation: "createMultipartUpload", options });
          const id = String(++nextUpload);
          uploads.set(id, new Map());
          return multipart(key, id);
        }),
      ),
    resumeMultipartUpload: (key, id) => {
      if (!key) throw new Error("a key is 1 to 1024 bytes");
      return multipart(key, id);
    },
  };
  const client = makeReadWriteBucketClient(
    makeR2BucketHelpers({ FILES: native }, { LogicalId: "FILES" }),
  );
  return { client, native, calls, uploads };
};

describe("Celld R2 native client adapters", () => {
  test.effect(
    "CRUD preserves metadata, missing objects and conditional responses",
    () =>
      request(
        Effect.gen(function* () {
          const { client } = fixture();
          expect(yield* client.head("missing")).toBeNull();
          expect(yield* client.get("missing")).toBeNull();
          const created = yield* client.put("object", "hello", {
            httpMetadata: { contentType: "text/plain" },
            customMetadata: { author: "sam" },
          });
          expect(created.key).toBe("object");
          expect(created.customMetadata).toEqual({ author: "sam" });
          const headers = yield* Effect.sync(() => new Headers());
          yield* created.writeHttpMetadata(headers);
          expect(headers.get("content-type")).toBe("text/plain");
          const unchanged = yield* client.get("object", {
            onlyIf: { etagMatches: "mismatch" },
          });
          expect(unchanged && "body" in unchanged).toBe(false);
          expect(
            yield* client.put("object", "ignored", {
              onlyIf: { etagMatches: "mismatch" },
            }),
          ).toBeNull();
          const body = yield* client.get("object");
          expect(body?.bodyUsed).toBe(false);
          expect(yield* body!.text()).toBe("hello");
          expect(body?.bodyUsed).toBe(true);
          yield* client.put("object", "updated");
          expect((yield* client.head("object"))?.size).toBe(7);
          yield* client.delete(["object", "missing"]);
          yield* client.delete("object");
          expect(yield* client.head("object")).toBeNull();
        }),
      ),
  );

  test.effect(
    "streams have no FixedLengthStream dependency and preserve all write options",
    () =>
      request(
        Effect.gen(function* () {
          const { client, calls } = fixture();
          const options: PutOptions = {
            contentLength: 3,
            sha256: "digest",
            customMetadata: { stream: "yes" },
            httpMetadata: { contentType: "application/octet-stream" },
          };
          yield* client.put(
            "bytes",
            Stream.make(new Uint8Array([0, 255, 1])),
            options,
          );
          expect(calls[0].options).toEqual({
            sha256: "digest",
            customMetadata: { stream: "yes" },
            httpMetadata: { contentType: "application/octet-stream" },
          });
          const value = yield* client.get("bytes");
          expect(Array.from(yield* value!.bytes())).toEqual([0, 255, 1]);
          yield* client.put("empty", Stream.empty);
          expect((yield* client.head("empty"))?.size).toBe(0);
          yield* client.put("no-length", Stream.make(new Uint8Array([2])));
          expect((yield* client.head("no-length"))?.size).toBe(1);
          const blob = yield* Effect.sync(() => new Blob(["blob"]));
          yield* client.put("blob", blob);
          expect(yield* (yield* client.get("blob"))!.text()).toBe("blob");
        }),
      ),
  );

  test.effect(
    "forwards ranges, header conditions and listing pagination options",
    () =>
      request(
        Effect.gen(function* () {
          const { client, calls } = fixture();
          yield* client.put("p/a", "abcdef");
          yield* client.put("p/b", "{}", { customMetadata: { n: "1" } });
          const ranged = yield* client.get("p/a", {
            range: { offset: 1, length: 2 },
          });
          expect(yield* ranged!.text()).toBe("bc");
          const headers = yield* Effect.sync(
            () => new Headers({ "if-match": "etag" }),
          );
          yield* client.get("p/a", { onlyIf: headers });
          expect(calls.at(-1)?.options).toEqual({ onlyIf: headers });
          const options = {
            prefix: "p/",
            startAfter: "p/",
            limit: 1,
            delimiter: "/",
            include: ["customMetadata", "httpMetadata"] as (
              | "customMetadata"
              | "httpMetadata"
            )[],
          };
          const first = yield* client.list(options);
          expect(calls.at(-1)?.options).toBe(options);
          expect(first.truncated).toBe(true);
          if (first.truncated) {
            const second = yield* client.list({
              prefix: "p/",
              cursor: first.cursor,
            });
            expect(second.truncated).toBe(false);
            expect("cursor" in second).toBe(false);
            expect(second.objects[0].customMetadata).toEqual({ n: "1" });
          }
        }),
      ),
  );

  test.effect("wraps body readers and body-stream errors in R2Error", () =>
    request(
      Effect.gen(function* () {
        const { client, native } = fixture();
        yield* client.put("json", '{"ok":true}');
        const json = yield* client.get("json");
        expect(yield* json!.json<{ ok: boolean }>()).toEqual({ ok: true });
        const blob = yield* client.get("json");
        expect((yield* blob!.blob()).size).toBe(11);
        const buffer = yield* client.get("json");
        expect((yield* buffer!.arrayBuffer()).byteLength).toBe(11);
        const stream = yield* client.get("json");
        expect((yield* Stream.runCollect(stream!.body)).length).toBe(1);
        yield* client.put("invalid", "invalid json");
        const invalid = yield* client.get("invalid");
        const result = yield* Effect.result(invalid!.json());
        expect(Result.isFailure(result) && result.failure._tag).toBe(
          "Celld.R2.R2Error",
        );
        const metadata = (yield* Effect.tryPromise(() =>
          native.head("invalid"),
        ))!;
        native.get = () =>
          Effect.runPromise(
            Effect.sync(() => ({
              ...metadata,
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(null);
                },
              }),
              bodyUsed: false,
              arrayBuffer: () => {
                throw null;
              },
              bytes: () => {
                throw null;
              },
              text: () => {
                throw null;
              },
              json: () => {
                throw null;
              },
              blob: () => {
                throw null;
              },
            })),
          );
        const broken = yield* client.get("invalid");
        const failedStream = yield* Effect.result(
          Stream.runDrain(broken!.body),
        );
        expect(
          Result.isFailure(failedStream) && failedStream.failure._tag,
        ).toBe("Celld.R2.R2Error");
        const failedText = yield* Effect.result(broken!.text());
        expect(
          Result.isFailure(failedText) && failedText.failure.cause,
        ).toBeNull();
      }),
    ),
  );

  test.effect(
    "multipart upload, resume, complete and abort preserve native failure semantics",
    () =>
      request(
        Effect.gen(function* () {
          const { client, uploads } = fixture();
          const upload = yield* client.createMultipartUpload("multipart", {
            customMetadata: { kind: "upload" },
          });
          expect(upload.key).toBe("multipart");
          const first = yield* upload.uploadPart(1, "hello");
          expect(first.etag).toBe("");
          const resumed = yield* client.resumeMultipartUpload(
            "multipart",
            upload.uploadId,
          );
          const second = yield* resumed.uploadPart(
            2,
            Stream.make(new Uint8Array([33])),
          );
          expect((yield* resumed.complete([first, second])).key).toBe(
            "multipart",
          );
          expect(yield* (yield* client.get("multipart"))!.text()).toBe(
            "hello!",
          );
          const aborted = yield* client.createMultipartUpload("aborted");
          yield* aborted.abort();
          const lost = yield* client.createMultipartUpload("lost");
          uploads.clear();
          const lostHandle = yield* client.resumeMultipartUpload(
            "lost",
            lost.uploadId,
          );
          const lostResult = yield* Effect.result(lostHandle.complete([]));
          expect(
            Result.isFailure(lostResult) && lostResult.failure.message,
          ).toContain("not found on this node");
          const syncError = yield* Effect.result(
            client.resumeMultipartUpload("", "id"),
          );
          expect(Result.isFailure(syncError) && syncError.failure._tag).toBe(
            "Celld.R2.R2Error",
          );
        }),
      ),
  );

  test.effect(
    "unsupported options and missing bindings fail with typed errors",
    () =>
      request(
        Effect.gen(function* () {
          const { client, calls, native } = fixture();
          const rejected: Effect.Effect<unknown, R2Error, RuntimeContext>[] = [
            client.get("x", { ssecKey: "key" }),
            client.put("x", "value", { ssecKey: "key" }),
            client.createMultipartUpload("x", { ssecKey: "key" }),
            client.get("x", { onlyIf: { secondsGranularity: true } }),
          ];
          for (const effect of rejected) {
            const result = yield* Effect.result(effect);
            expect(Result.isFailure(result) && result.failure._tag).toBe(
              "Celld.R2.R2Error",
            );
          }
          expect(calls).toEqual([]);
          const upload = yield* client.createMultipartUpload("x");
          const unsupportedPart = yield* Effect.result(
            upload.uploadPart(1, "x", { ssecKey: "key" }),
          );
          expect(
            Result.isFailure(unsupportedPart) &&
              unsupportedPart.failure.message,
          ).toContain("ssecKey");
          native.put = () => {
            throw new Error("conditional put exceeds one request");
          };
          const tooLarge = yield* Effect.result(
            client.put("x", "x", { onlyIf: { etagMatches: "etag" } }),
          );
          expect(
            Result.isFailure(tooLarge) && tooLarge.failure.message,
          ).toContain("exceeds one request");
          const missing = makeReadWriteBucketClient(
            makeR2BucketHelpers({}, { LogicalId: "missing" }),
          );
          const result = yield* Effect.result(missing.head("x"));
          expect(Result.isFailure(result) && result.failure.message).toContain(
            "Missing Celld R2 binding",
          );
        }),
      ),
  );

  test("owns callable service identities", () => {
    expect(typeof ReadBucket).toBe("function");
    expect(ReadBucket.key).toBe("Celld.R2.ReadBucket");
    expect(WriteBucket.key).toBe("Celld.R2.WriteBucket");
    expect(ReadWriteBucket.key).toBe("Celld.R2.ReadWriteBucket");
  });
});
