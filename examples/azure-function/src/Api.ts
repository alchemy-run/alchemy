import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Files } from "./Files.ts";

const FILE_ROUTE = /^\/files\/(.+)$/;

/**
 * A file API on Azure Functions (Flex Consumption):
 *
 * - `GET /files?prefix=p` lists the files
 * - `PUT /files/:key` stores the request body
 * - `GET /files/:key` reads a file back
 * - `DELETE /files/:key` deletes it
 *
 * `BlobContainerReadWrite` grants the app's managed identity
 * **Storage Blob Data Contributor** on the container. No keys or
 * connection strings reach the app.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const container = yield* Files;
    const files = yield* Azure.Storage.BlobContainerReadWrite(container);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (url.pathname === "/files" && request.method === "GET") {
          const page = yield* files.list({ prefix: url.searchParams.get("prefix") ?? undefined });
          return yield* HttpServerResponse.json({
            files: page.blobs.map(({ key, size, contentType }) => ({ key, size, contentType })),
          });
        }

        const match = FILE_ROUTE.exec(url.pathname);
        if (match === null) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const key = decodeURIComponent(match[1]!);

        if (request.method === "PUT") {
          const body = yield* request.text;
          const contentType = request.headers["content-type"] ?? "text/plain";
          const { etag } = yield* files.put(key, body, { contentType });
          return yield* HttpServerResponse.json({ key, etag }, { status: 201 });
        }
        if (request.method === "GET") {
          const file = yield* files.get(key);
          return file === undefined
            ? HttpServerResponse.text("Not Found", { status: 404 })
            : HttpServerResponse.text(file.text(), { contentType: file.contentType });
        }
        if (request.method === "DELETE") {
          yield* files.delete(key);
          return HttpServerResponse.empty({ status: 204 });
        }
        return HttpServerResponse.text("Method Not Allowed", { status: 405 });
      }).pipe(
        // Every Azure error is a typed tag. Answer it with a 502 so a caller
        // sees which one (e.g. while the role assignment propagates).
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.text(error._tag, { status: 502 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
) {}
