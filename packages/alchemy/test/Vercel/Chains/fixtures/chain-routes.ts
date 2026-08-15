/**
 * Shared route table for the storage-compute chain fixtures. Each fixture
 * class (`chain-fn.ts` / `chain-fn-rotated.ts` / `chain-fn-noblob.ts`)
 * composes this with its own binding set, so the three "generations" of the
 * Function under test serve identical routes.
 */
import type { ReadWriteBlobClient } from "@/Vercel/Blob/ReadWriteBlob.ts";
import type { ReadEdgeConfigClient } from "@/Vercel/EdgeConfig/EdgeConfigRead.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const makeChainFetch = (
  config: ReadEdgeConfigClient,
  blob: ReadWriteBlobClient | undefined,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = yield* Effect.sync(
      () => new globalThis.URL(request.url, "http://localhost"),
    );
    const path = url.pathname;
    const q = (key: string) => url.searchParams.get(key) ?? "";

    if (path.startsWith("/flag/")) {
      const key = decodeURIComponent(path.slice("/flag/".length));
      const value = yield* config.get(key).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ value: value ?? null });
    }
    if (path === "/digest") {
      const digest = yield* config.digest().pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ digest });
    }
    if (path === "/secret") {
      const secret = yield* Effect.sync(() => process.env.CHAIN_SECRET ?? null);
      return yield* HttpServerResponse.json({ secret });
    }
    if (path.startsWith("/blob/")) {
      if (blob === undefined) {
        return yield* HttpServerResponse.json({ blob: false });
      }
      if (path === "/blob/put") {
        const put = yield* blob
          .put(q("path"), q("body"), { contentType: "text/plain" })
          .pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          etag: put.etag,
          url: put.url,
          pathname: put.pathname,
        });
      }
      if (path === "/blob/get") {
        const result = yield* blob.get(q("path")).pipe(
          Effect.flatMap((got) => Effect.map(got.text, (text) => ({ text }))),
          Effect.catchTag("Vercel.Blob.NotFound", () =>
            Effect.succeed({ notFound: true }),
          ),
          Effect.orDie,
        );
        return yield* HttpServerResponse.json(result);
      }
      if (path === "/blob/del") {
        yield* blob.del(q("path")).pipe(Effect.orDie);
        return yield* HttpServerResponse.json({ ok: true });
      }
    }
    return yield* HttpServerResponse.json({ ok: true });
  });
