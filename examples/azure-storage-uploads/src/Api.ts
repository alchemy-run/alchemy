import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { FILES_PARTITION, Files, Uploads, blobFor, isValidName } from "./resources.ts";

/**
 * The front door of the upload pipeline.
 *
 * Uploads go straight to Blob Storage; this Function never computes
 * anything about them. The {@link ./Indexer.ts Indexer} picks each one up
 * from the container's `BlobCreated` event and writes the metadata that
 * `GET /files` serves.
 *
 * - `PUT /files/:name` — store the request body at `uploads/:name`.
 * - `GET /files/:name` — return the stored bytes.
 * - `GET /files` — list the indexed metadata from Table storage.
 * - `DELETE /files/:name` — delete the blob and its metadata.
 *
 * The HTTP function is anonymous. Put real authentication in front of it
 * before storing anything that matters.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const uploads = yield* Uploads;
    const files = yield* Files;

    // Storage Blob Data Contributor on the container: read, write, delete.
    const blobs = yield* Azure.Storage.BlobContainerReadWrite(uploads);
    // Listing metadata and removing it on delete.
    const records = yield* Azure.Storage.TableReadWrite(files);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "GET" && segments.length === 1 && segments[0] === "files") {
          const page = yield* records.query({
            filter: `PartitionKey eq '${FILES_PARTITION}'`,
            top: 100,
          });
          return yield* HttpServerResponse.json({
            files: page.entities.map(
              ({ PartitionKey: _pk, RowKey: _rk, Timestamp: _ts, etag: _etag, ...record }) =>
                record,
            ),
          });
        }

        if (segments.length !== 2 || segments[0] !== "files") {
          return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 });
        }

        const name = decodeURIComponent(segments[1]!);
        if (!isValidName(name)) {
          return yield* HttpServerResponse.json(
            { error: "names are 1-128 characters of [A-Za-z0-9._-]" },
            { status: 400 },
          );
        }

        if (request.method === "PUT") {
          const body = new Uint8Array(yield* request.arrayBuffer);
          const written = yield* blobs.put(blobFor(name), body, {
            contentType: request.headers["content-type"] ?? "application/octet-stream",
          });
          // 202: the bytes are stored, the metadata follows asynchronously.
          return yield* HttpServerResponse.json(
            { name, blob: blobFor(name), etag: written.etag, size: body.byteLength },
            { status: 202 },
          );
        }

        if (request.method === "GET") {
          const blob = yield* blobs.get(blobFor(name));
          if (blob === undefined) {
            return yield* HttpServerResponse.json({ error: "no such file" }, { status: 404 });
          }
          return HttpServerResponse.uint8Array(blob.body, {
            contentType: blob.contentType ?? "application/octet-stream",
          });
        }

        if (request.method === "DELETE") {
          yield* blobs.delete(blobFor(name));
          yield* records.delete(FILES_PARTITION, name);
          return HttpServerResponse.empty({ status: 204 });
        }

        return yield* HttpServerResponse.json({ error: "method not allowed" }, { status: 405 });
      }).pipe(
        // A failed Azure call (e.g. a role assignment still propagating
        // after the first deploy) answers 500, so clients can retry.
        Effect.orDie,
      ),
    };
  }).pipe(
    Effect.provide([Azure.Storage.BlobContainerReadWriteHttp, Azure.Storage.TableReadWriteHttp]),
  ),
) {}
