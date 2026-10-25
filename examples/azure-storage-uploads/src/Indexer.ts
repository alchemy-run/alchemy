import { createHash } from "node:crypto";
import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import { FILES_PARTITION, Files, UPLOADS_PREFIX, Uploads, type FileRecord } from "./resources.ts";

const sha256Hex = (bytes: Uint8Array) =>
  Effect.sync(() => createHash("sha256").update(bytes).digest("hex"));

/**
 * The background half of the pipeline: index every finished upload.
 *
 * Blob Storage publishes a `Microsoft.Storage.BlobCreated` event for each
 * blob written under `uploads/`; an Event Grid subscription pushes it to
 * this Function's native `eventGridTrigger`, which reads the blob back,
 * hashes it, and records the result in Table storage. Nothing here runs on
 * the upload's request path, so a slow hash of a large file never delays
 * the client.
 */
export default class Indexer extends Azure.Functions.Function<Indexer>()(
  "Indexer",
  { main: import.meta.url },
  Effect.gen(function* () {
    const uploads = yield* Uploads;
    const files = yield* Files;

    // Storage Blob Data Reader on the container.
    const blobs = yield* Azure.Storage.BlobContainerRead(uploads);
    // Insert, update, and delete entities on the table, without reads.
    const records = yield* Azure.Storage.TableWrite(files);

    yield* Azure.Storage.consumeBlobCreated(uploads, { prefix: UPLOADS_PREFIX }, (event) =>
      Effect.gen(function* () {
        // The blob may have been deleted since the event fired. The delete
        // owns the record then, so there is nothing to do.
        const blob = yield* blobs.get(event.blobName);
        if (blob === undefined) {
          yield* Effect.log(`indexer: ${event.blobName} is gone, skipping`);
          return;
        }

        const name = event.blobName.slice(UPLOADS_PREFIX.length);
        const sha256 = yield* sha256Hex(blob.body);
        const record: FileRecord = {
          name,
          blob: event.blobName,
          blobEtag: blob.etag ?? "",
          size: blob.body.byteLength,
          contentType: blob.contentType ?? event.contentType ?? "application/octet-stream",
          sha256,
          indexedAt: new Date().toISOString(),
        };

        // Upsert makes redelivery safe: a repeated event rewrites the row
        // with the same values.
        yield* records.upsert({ PartitionKey: FILES_PARTITION, RowKey: name, ...record });
        yield* Effect.log(`indexer: ${name} (${record.size} bytes)`);
      }).pipe(
        // Right after the first deploy the Indexer's data roles may not have
        // propagated yet (403 `AuthorizationPermissionMismatch`): retry for
        // about 25 seconds, inside Event Grid's delivery timeout, before
        // handing the event back to Event Grid.
        Effect.retry({
          while: (e) =>
            e._tag === "SchemaRegistryStorageAccessDenied" || e._tag === "TablePermissionDenied",
          schedule: Schedule.spaced("5 seconds"),
          times: 5,
        }),
        // A failure fails the invocation, so Event Grid redelivers the event.
        Effect.orDie,
      ),
    );

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(
    Effect.provide([
      Azure.Functions.BlobCreatedEventSource,
      Azure.Storage.BlobContainerReadHttp,
      Azure.Storage.TableWriteHttp,
    ]),
  ),
) {}
