import type { WriteBucketClient } from "@/Prisma/WriteBucket.ts";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared write-side routes so every write method of
 * {@link WriteBucketClient} is driven over `fetch`:
 *
 * - `PUT /put?key=` — `put(key, body)` (returns the object key to prove the
 *   call resolved a `BucketObject`).
 * - `DELETE /del?key=` — `delete(key)` (single).
 * - `DELETE /del-many?keys=a,b,c` — `delete(keys)` (batch). Keys travel as a
 *   comma-separated query param rather than a request body because DELETE
 *   bodies are unreliable across `fetch`.
 *
 * Returns `undefined` when the path is not a write route so the caller can
 * fall through (used by the read-write fixture).
 */
export const writeRoutes = (
  store: WriteBucketClient,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    if (request.method === "PUT" && url.pathname === "/put") {
      const key = url.searchParams.get("key") ?? "";
      const body = yield* request.text;
      const object = yield* store.put(key, body).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true, key: object.key });
    }
    if (request.method === "DELETE" && url.pathname === "/del") {
      const key = url.searchParams.get("key") ?? "";
      yield* store.delete(key).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (request.method === "DELETE" && url.pathname === "/del-many") {
      const keys = (url.searchParams.get("keys") ?? "")
        .split(",")
        .filter((key) => key.length > 0);
      yield* store.delete(keys).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    return undefined;
  });
