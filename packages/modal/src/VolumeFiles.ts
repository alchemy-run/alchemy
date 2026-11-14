import { createHash } from "node:crypto";
import * as volume from "@distilled.cloud/modal/volume";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { operations } from "./internal.ts";

/** A block upload or download to a URL Modal handed out failed. */
export class VolumeTransferError extends Data.TaggedError("Modal.VolumeTransferError")<{
  readonly path: string;
  readonly message: string;
}> {}

/** One entry of a volume directory listing. */
export interface VolumeFileEntry {
  /** Path relative to the volume root. */
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  /** Size in bytes (files). */
  readonly size: number;
  /** Modification time, seconds since the epoch. */
  readonly mtime: number;
}

const BLOCK_SIZE = 8 * 1024 * 1024;

/** The operations a volume's files need, resolved by `ModalBindings.withCredentials`. */
export const VolumeFileOps = operations({
  getFile: volume.volumeGetFile2,
  listFiles: volume.volumeListFiles2,
  putFiles: volume.volumePutFiles2,
  removeFile: volume.volumeRemoveFile2,
  copyFiles: volume.volumeCopyFiles2,
  http: HttpClient.HttpClient,
});

export type VolumeFileOps = Effect.Success<typeof VolumeFileOps>;

const typeOf = (type: string | undefined): VolumeFileEntry["type"] =>
  type === "FILE"
    ? "file"
    : type === "DIRECTORY"
      ? "directory"
      : type === "SYMLINK"
        ? "symlink"
        : "other";

const toBytes = (data: string | Uint8Array) =>
  Effect.sync(() => (typeof data === "string" ? new TextEncoder().encode(data) : data));

/**
 * Read a file from a (v2) volume: Modal returns presigned URLs for the
 * file's blocks, which are fetched and concatenated.
 */
export const readVolumeFile = Effect.fn(function* (
  ops: VolumeFileOps,
  volumeId: string,
  path: string,
) {
  const { getUrls, size } = yield* ops.getFile({ volumeId, path });
  const total = Number(size ?? 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const url of getUrls ?? []) {
    // A presigned block URL returned by VolumeGetFile2 (allowed raw HTTP).
    const response = yield* ops.http.execute(HttpClientRequest.get(url));
    if (response.status >= 300) {
      return yield* new VolumeTransferError({
        path,
        message: `Downloading a block of ${path} failed with HTTP ${response.status}`,
      });
    }
    const buffer = yield* response.arrayBuffer;
    const block = new Uint8Array(buffer);
    out.set(block.subarray(0, Math.max(0, total - offset)), offset);
    offset += Math.min(block.length, BLOCK_SIZE);
  }
  return out;
});

/** List a directory of a (v2) volume. */
export const listVolumeFiles = Effect.fn(function* (
  ops: VolumeFileOps,
  volumeId: string,
  path: string,
  options: { readonly recursive?: boolean } = {},
) {
  const { items } = yield* ops.listFiles({
    volumeId,
    path,
    recursive: options.recursive ?? false,
  });
  return items.flatMap((batch) =>
    (batch.entries ?? []).map((entry): VolumeFileEntry => ({
      path: entry.path ?? "",
      type: typeOf(entry.type),
      size: Number(entry.size ?? 0),
      mtime: Number(entry.mtime ?? 0),
    })),
  );
});

/**
 * Write a file to a (v2) volume: send each 8 MiB block's SHA-256, upload
 * the blocks Modal reports missing to the URLs it returns, then commit with
 * the upload responses.
 */
export const writeVolumeFile = Effect.fn(function* (
  ops: VolumeFileOps,
  volumeId: string,
  path: string,
  data: string | Uint8Array,
  options: { readonly mode?: number } = {},
) {
  const bytes = yield* toBytes(data);
  const blocks = yield* Effect.sync(() => {
    const out: { readonly data: Uint8Array; readonly sha256: string }[] = [];
    for (let offset = 0; offset === 0 || offset < bytes.length; offset += BLOCK_SIZE) {
      const block = bytes.subarray(offset, offset + BLOCK_SIZE);
      out.push({ data: block, sha256: createHash("sha256").update(block).digest("base64") });
      if (bytes.length === 0) break;
    }
    return out;
  });
  const putResponses = new Map<number, string>();
  for (let round = 0; round < 3; round++) {
    const { missingBlocks } = yield* ops.putFiles({
      volumeId,
      files: [
        {
          path,
          size: String(bytes.length),
          mode: options.mode ?? 0o644,
          blocks: blocks.map((block, index) => ({
            contentsSha256: block.sha256,
            putResponse: putResponses.get(index),
          })),
        },
      ],
    });
    if (!missingBlocks || missingBlocks.length === 0) return;
    for (const missing of missingBlocks) {
      const index = Number(missing.blockIndex ?? 0);
      const block = blocks[index];
      if (!block || !missing.putUrl) continue;
      // A presigned block URL returned by VolumePutFiles2 (allowed raw HTTP).
      const response = yield* ops.http.execute(
        HttpClientRequest.put(missing.putUrl).pipe(
          HttpClientRequest.bodyUint8Array(block.data, "application/octet-stream"),
        ),
      );
      if (response.status >= 300) {
        return yield* new VolumeTransferError({
          path,
          message: `Uploading block ${index} of ${path} failed with HTTP ${response.status}`,
        });
      }
      const body = yield* response.arrayBuffer;
      const encoded = yield* Effect.sync(() => Buffer.from(body).toString("base64"));
      putResponses.set(index, encoded);
    }
  }
  return yield* new VolumeTransferError({
    path,
    message: `Modal kept reporting blocks of ${path} missing after upload`,
  });
});

/** Remove a file (or, with `recursive`, a directory) from a (v2) volume. */
export const removeVolumeFile = Effect.fn(function* (
  ops: VolumeFileOps,
  volumeId: string,
  path: string,
  options: { readonly recursive?: boolean } = {},
) {
  yield* ops.removeFile({ volumeId, path, recursive: options.recursive ?? false });
});

/** Copy files inside a (v2) volume. */
export const copyVolumeFiles = Effect.fn(function* (
  ops: VolumeFileOps,
  volumeId: string,
  sources: ReadonlyArray<string>,
  destination: string,
  options: { readonly recursive?: boolean } = {},
) {
  yield* ops.copyFiles({
    volumeId,
    srcPaths: [...sources],
    dstPath: destination,
    recursive: options.recursive ?? false,
  });
});
