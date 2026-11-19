import { createHash } from "node:crypto";
import * as blob from "@distilled.cloud/modal/blob";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { operations } from "./internal.ts";

/** Inputs and results above this size travel through Modal's blob store. */
export const MAX_INLINE_BYTES = 2 * 1024 * 1024;

/** A payload Modal's blob store couldn't take or give back. */
export class BlobTransferFailed extends Data.TaggedError("Modal.BlobTransferFailed")<{
  readonly message: string;
}> {}

/** The blob operations, resolved by `ModalBindings.withCredentials`. */
export const BlobOps = operations({
  create: blob.createBlob,
  get: blob.getBlob,
  http: HttpClient.HttpClient,
});

export type BlobOps = Effect.Success<typeof BlobOps>;

/** Upload bytes to Modal's blob store and return the blob id. */
export const uploadBlob = Effect.fn(function* (ops: BlobOps, bytes: Uint8Array) {
  const digests = yield* Effect.sync(() => ({
    md5: createHash("md5").update(bytes).digest("base64"),
    sha256: createHash("sha256").update(bytes).digest("base64"),
  }));
  const created = yield* ops.create({
    contentMd5: digests.md5,
    contentSha256Base64: digests.sha256,
    contentLength: String(bytes.length),
  });
  if (!created.blobId || !created.uploadUrl) {
    return yield* new BlobTransferFailed({
      message: `Modal asked for a multipart upload of ${bytes.length} bytes, which this client doesn't send`,
    });
  }
  // A presigned upload URL Modal handed back: used as-is.
  const response = yield* ops.http.execute(
    HttpClientRequest.put(created.uploadUrl).pipe(
      HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
      HttpClientRequest.setHeader("content-md5", digests.md5),
    ),
  );
  if (response.status >= 300) {
    return yield* new BlobTransferFailed({
      message: `Uploading a blob failed with HTTP ${response.status}`,
    });
  }
  return created.blobId;
});

/** Download a blob's bytes. */
export const downloadBlob = Effect.fn(function* (ops: BlobOps, blobId: string) {
  const { downloadUrl } = yield* ops.get({ blobId });
  if (!downloadUrl) {
    return yield* new BlobTransferFailed({ message: `Modal returned no URL for blob ${blobId}` });
  }
  // A presigned download URL Modal handed back: used as-is.
  const response = yield* ops.http.get(downloadUrl);
  if (response.status >= 300) {
    return yield* new BlobTransferFailed({
      message: `Downloading blob ${blobId} failed with HTTP ${response.status}`,
    });
  }
  return new Uint8Array(yield* response.arrayBuffer);
});
