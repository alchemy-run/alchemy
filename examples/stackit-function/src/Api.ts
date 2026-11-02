import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { Puller, registryFor } from "./registry.ts";
import { Files } from "./resources.ts";

/**
 * A file store on a STACKIT Function.
 *
 * - `PUT /files/:key` stores the request body.
 * - `GET /files/:key` returns it, or `404`.
 * - `GET /files` lists the keys.
 * - `DELETE /files/:key` removes it.
 *
 * `Stackit.ObjectStorage.ReadWriteBucket` creates a credentials group and an
 * access key for this function, limits the group to the bucket's read and write
 * actions through the bucket's policy, and binds the key into the function's env.
 */
export default class Api extends Stackit.Functions.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    const puller = yield* Puller;
    const registry = yield* registryFor("api");
    return {
      main: import.meta.url,
      registry,
      pullCredential: puller.pullCredentialId,
    };
  }),
  Effect.gen(function* () {
    const files = yield* Stackit.ObjectStorage.ReadWriteBucket(yield* Files);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://function");
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "GET" && url.pathname === "/files") {
          const listed = yield* files.listObjects();
          const keys = (listed.Contents ?? []).map((object) => object.Key);
          return yield* HttpServerResponse.json({ keys });
        }

        if (segments[0] === "files" && segments.length === 2) {
          const key = decodeURIComponent(segments[1]!);

          if (request.method === "PUT") {
            yield* files.putObject({ Key: key, Body: yield* request.text });
            return HttpServerResponse.empty({ status: 204 });
          }

          if (request.method === "GET") {
            return yield* files.getObject({ Key: key }).pipe(
              Effect.flatMap((object) => Stream.mkString(Stream.decodeText(object.Body!))),
              Effect.map((text) => HttpServerResponse.text(text)),
              Effect.catchTag("NoSuchKey", () =>
                Effect.succeed(HttpServerResponse.text("no such file", { status: 404 })),
              ),
            );
          }

          if (request.method === "DELETE") {
            yield* files.deleteObject({ Key: key });
            return HttpServerResponse.empty({ status: 204 });
          }
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Stackit.ObjectStorage.ReadWriteBucketHttp)),
) {}
