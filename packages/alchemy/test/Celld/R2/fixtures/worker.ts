import type { Bucket } from "@/Celld/R2/Bucket";
import { ReadWriteBucket } from "@/Celld/R2/ReadWriteBucket";
import { ReadWriteBucketBinding } from "@/Celld/R2/ReadWriteBucketBinding";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Worker implementation for the parent's real Celld 0.5 fleet and bucket. */
export const r2BindingConformance = (bucket: Bucket) =>
  Effect.gen(function* () {
    const files = yield* ReadWriteBucket(bucket);
    return {
      fetch: Effect.gen(function* () {
        const prefix = "alchemy-r2-binding/";
        const textKey = `${prefix}a`;
        const bytesKey = `${prefix}b`;
        const multipartKey = `${prefix}c`;
        yield* files.delete([textKey, bytesKey, multipartKey]);
        const missing = yield* files.get(textKey);
        const written = yield* files.put(textKey, '{"hello":"celld"}', {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { version: "1" },
        });
        const head = yield* files.head(textKey);
        const body = yield* files.get(textKey);
        const json = yield* body!.json<{ hello: string }>();
        const consumed = body!.bodyUsed;
        const headers = yield* Effect.sync(() => new Headers());
        yield* head!.writeHttpMetadata(headers);
        const unmatched = yield* files.get(textKey, {
          onlyIf: { etagMatches: "mismatch" },
        });
        const refused = yield* files.put(textKey, "ignored", {
          onlyIf: { etagMatches: "mismatch" },
        });
        yield* files.put(bytesKey, Stream.make(new Uint8Array([0, 255, 1])));
        const binary = yield* files.get(bytesKey);
        const bytes = Array.from(yield* binary!.bytes());
        const ranged = yield* files.get(bytesKey, {
          range: { offset: 1, length: 1 },
        });
        const range = Array.from(yield* ranged!.bytes());
        const first = yield* files.list({
          prefix,
          limit: 1,
          include: ["customMetadata", "httpMetadata"],
        });
        const second = first.truncated
          ? yield* files.list({ prefix, cursor: first.cursor, limit: 1 })
          : undefined;
        const unsupported = yield* Effect.result(
          files.get(textKey, { ssecKey: "unsupported" }),
        );
        const granularity = yield* Effect.result(
          files.get(textKey, { onlyIf: { secondsGranularity: true } }),
        );
        const upload = yield* files.createMultipartUpload(multipartKey);
        const part = yield* upload.uploadPart(1, "multipart");
        const resumed = yield* files.resumeMultipartUpload(
          multipartKey,
          upload.uploadId,
        );
        yield* resumed.complete([part]);
        const multipart = yield* (yield* files.get(multipartKey))!.text();
        const aborted = yield* files.createMultipartUpload(multipartKey);
        yield* aborted.abort();
        yield* files.delete([textKey, bytesKey, multipartKey]);
        yield* files.delete(textKey);
        const deleted = yield* files.head(textKey);
        const empty = yield* files.list({ prefix });
        return yield* HttpServerResponse.json({
          missing,
          key: written.key,
          metadata: head!.customMetadata,
          contentType: headers.get("content-type"),
          json,
          consumed,
          unmatchedHasBody: unmatched !== null && "body" in unmatched,
          refused,
          bytes,
          range,
          first: {
            truncated: first.truncated,
            keys: first.objects.map((object) => object.key),
          },
          second: second && {
            truncated: second.truncated,
            keys: second.objects.map((object) => object.key),
          },
          unsupported: Result.isFailure(unsupported)
            ? unsupported.failure._tag
            : null,
          granularity: Result.isFailure(granularity)
            ? granularity.failure._tag
            : null,
          partEtag: part.etag,
          multipart,
          deleted,
          remaining: empty.objects.length,
        });
      }),
    };
  }).pipe(Effect.provide(ReadWriteBucketBinding));
