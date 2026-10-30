import type { WriteBucketClient } from "@alchemy.run/prisma/WriteBucket";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";

/**
 * Shared write-side routes so every method of {@link WriteBucketClient} is
 * driven over `fetch`:
 *
 * - `PUT /put?key=` — `put(key, body)` (returns the object key to prove the
 *   call resolved a `BucketObject`, or the `BucketError` message). `as`
 *   picks the body kind (`bytes`, `stream`, `stream-sized`; text by default).
 *   `contentType`, `cacheControl`, `contentDisposition`, `metaKey` and
 *   `metaValue` travel as query params and are passed through as
 *   `PutOptions`, so the read side can observe them.
 * - `DELETE /del?key=` — `delete(key)` (single).
 * - `DELETE /del-many?keys=a,b,c` — `delete(keys)` (batch). Keys travel as a
 *   comma-separated query param rather than a request body because DELETE
 *   bodies are unreliable across `fetch`.
 * - `GET /presign-put?key=` — `presignPut(key)`.
 *
 * Returns `undefined` when the path is not a write route so the caller can
 * fall through (used by the read-write fixtures).
 */
export const writeRoutes = (
  store: WriteBucketClient,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    if (request.method === "PUT" && url.pathname === "/put") {
      const key = url.searchParams.get("key") ?? "";
      const metaKey = url.searchParams.get("metaKey");
      const as = url.searchParams.get("as");
      const bytes = new Uint8Array(yield* request.arrayBuffer);
      const half = Math.ceil(bytes.length / 2);
      const body =
        as === "bytes"
          ? bytes
          : as?.startsWith("stream")
            ? Stream.make(bytes.slice(0, half), bytes.slice(half))
            : yield* Effect.sync(() => new TextDecoder().decode(bytes));
      const object = yield* store
        .put(key, body, {
          contentType: url.searchParams.get("contentType") ?? undefined,
          contentLength: as === "stream-sized" ? bytes.length : undefined,
          cacheControl: url.searchParams.get("cacheControl") ?? undefined,
          contentDisposition: url.searchParams.get("contentDisposition") ?? undefined,
          metadata: metaKey ? { [metaKey]: url.searchParams.get("metaValue") ?? "" } : undefined,
        })
        .pipe(
          Effect.map((object) => ({ ok: true, key: object.key })),
          Effect.catchTag("BucketError", (error) =>
            Effect.succeed({ ok: false, key: null, error: error.message }),
          ),
          Effect.orDie,
        );
      return yield* HttpServerResponse.json(object);
    }
    if (request.method === "DELETE" && url.pathname === "/del") {
      const key = url.searchParams.get("key") ?? "";
      yield* store.delete(key).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (request.method === "DELETE" && url.pathname === "/del-many") {
      const keys = (url.searchParams.get("keys") ?? "").split(",").filter((k) => k.length > 0);
      yield* store.delete(keys).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    // The app mints the URL from its bound credentials and hands it back; the
    // test then uploads to that URL directly, carrying no credentials of its
    // own.
    if (request.method === "GET" && url.pathname === "/presign-put") {
      const key = url.searchParams.get("key") ?? "";
      const expiresIn = url.searchParams.get("expiresIn");
      const contentType = url.searchParams.get("contentType");
      const presigned = yield* store
        .presignPut(key, {
          expiresIn: expiresIn ? Number(expiresIn) : undefined,
          contentType: contentType ?? undefined,
        })
        .pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ url: presigned });
    }
    return undefined;
  });
