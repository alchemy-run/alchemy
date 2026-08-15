/**
 * Effect-mode Vercel Function fixture for the Blob capability bindings:
 * `ReadWriteBlob` drives put/CAS/conditional-create/del, `ReadBlob` is the
 * least-privilege sibling (its client type has no `put`/`del`) used by the
 * `/blob/read` route.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Uploads } from "./uploads-store.ts";

export default class BlobFn extends Vercel.Function<BlobFn>()(
  "BlobFn",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const blob = yield* Vercel.ReadWriteBlob(Uploads);
    // Least-privilege: `reader.put` / `reader.del` do not exist on the type.
    const reader = yield* Vercel.ReadBlob(Uploads);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(
          () => new globalThis.URL(request.url, "http://localhost"),
        );
        const path = url.searchParams.get("path") ?? "";
        const body = url.searchParams.get("body") ?? "";
        const etag = url.searchParams.get("etag") ?? "";

        switch (url.pathname) {
          case "/blob/put": {
            const put = yield* blob
              .put(path, body, { contentType: "text/plain" })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              etag: put.etag,
              url: put.url,
              pathname: put.pathname,
            });
          }
          case "/blob/create": {
            const result = yield* blob
              .put(path, body, {
                contentType: "text/plain",
                allowOverwrite: false,
              })
              .pipe(
                Effect.map((put) => ({ etag: put.etag })),
                Effect.catchTag("Vercel.Blob.AlreadyExists", () =>
                  Effect.succeed({ alreadyExists: true }),
                ),
                Effect.orDie,
              );
            return yield* HttpServerResponse.json(result);
          }
          case "/blob/cas": {
            const result = yield* blob
              .put(path, body, { contentType: "text/plain", ifMatch: etag })
              .pipe(
                Effect.map((put) => ({ etag: put.etag })),
                Effect.catchTag("Vercel.Blob.PreconditionFailed", () =>
                  Effect.succeed({ precondition: true }),
                ),
                Effect.orDie,
              );
            return yield* HttpServerResponse.json(result);
          }
          case "/blob/get": {
            const result = yield* blob.get(path).pipe(
              Effect.flatMap((got) =>
                Effect.map(got.text, (text) => ({
                  text,
                  contentType: got.contentType,
                })),
              ),
              Effect.catchTag("Vercel.Blob.NotFound", () =>
                Effect.succeed({ notFound: true }),
              ),
              Effect.orDie,
            );
            return yield* HttpServerResponse.json(result);
          }
          case "/blob/head": {
            const result = yield* blob.head(path).pipe(
              Effect.map((meta) => ({
                size: meta.size,
                etag: meta.etag,
                pathname: meta.pathname,
              })),
              Effect.catchTag("Vercel.Blob.NotFound", () =>
                Effect.succeed({ notFound: true }),
              ),
              Effect.orDie,
            );
            return yield* HttpServerResponse.json(result);
          }
          case "/blob/list": {
            const listed = yield* blob
              .list({ prefix: url.searchParams.get("prefix") ?? undefined })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              pathnames: listed.blobs.map((row) => row.pathname).sort(),
            });
          }
          case "/blob/read": {
            // Through the read-only client.
            const result = yield* reader.get(path).pipe(
              Effect.flatMap((got) =>
                Effect.map(got.text, (text) => ({ text })),
              ),
              Effect.catchTag("Vercel.Blob.NotFound", () =>
                Effect.succeed({ notFound: true }),
              ),
              Effect.orDie,
            );
            return yield* HttpServerResponse.json(result);
          }
          case "/blob/del": {
            yield* blob.del(path).pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ ok: true });
          }
          default:
            return yield* HttpServerResponse.json({ ok: true });
        }
      }),
    };
  }).pipe(Effect.provide([Vercel.ReadWriteBlobHttp, Vercel.ReadBlobHttp])),
) {}
