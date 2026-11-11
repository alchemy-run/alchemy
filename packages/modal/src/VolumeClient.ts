import type {
  VolumeGetFile2Error,
  VolumeListFiles2Error,
  VolumeRemoveFile2Error,
  VolumeCopyFiles2Error,
  VolumePutFiles2Error,
} from "@distilled.cloud/modal/volume";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type { HttpClientError } from "effect/http/HttpClientError";
import {
  copyVolumeFiles,
  listVolumeFiles,
  readVolumeFile,
  removeVolumeFile,
  writeVolumeFile,
  type VolumeFileEntry,
  type VolumeFileOps,
  type VolumeTransferError,
} from "./VolumeFiles.ts";

/** Errors reading a volume file: `VolumeFileNotFound` when the path is missing. */
export type ReadVolumeFileError = VolumeGetFile2Error | VolumeTransferError | HttpClientError;
/** Errors listing a volume directory. */
export type ListVolumeFilesError = VolumeListFiles2Error;
/** Errors removing or copying volume files. */
export type ChangeVolumeFilesError = VolumeRemoveFile2Error | VolumeCopyFiles2Error;
/** Errors writing a volume file. */
export type WriteVolumeFileError = VolumePutFiles2Error | VolumeTransferError | HttpClientError;

/** Read access to one volume's files. */
export interface ReadVolumeClient {
  /** The volume's id. */
  readonly volumeId: Effect.Effect<string>;
  /** Read a file. */
  readFile(path: string): Effect.Effect<Uint8Array, ReadVolumeFileError, RuntimeContext>;
  /** Read a UTF-8 file. */
  readFileString(path: string): Effect.Effect<string, ReadVolumeFileError, RuntimeContext>;
  /** List a directory (`recursive` walks it). */
  listFiles(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Effect.Effect<ReadonlyArray<VolumeFileEntry>, ListVolumeFilesError, RuntimeContext>;
}

/** Write access to one volume's files. */
export interface WriteVolumeClient {
  /** The volume's id. */
  readonly volumeId: Effect.Effect<string>;
  /** Write (create or replace) a file. */
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { readonly mode?: number },
  ): Effect.Effect<void, WriteVolumeFileError, RuntimeContext>;
  /** Remove a file, or a directory with `recursive`. */
  removeFile(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Effect.Effect<void, ChangeVolumeFilesError, RuntimeContext>;
  /** Copy files to `destination` inside the volume. */
  copyFiles(
    sources: ReadonlyArray<string>,
    destination: string,
    options?: { readonly recursive?: boolean },
  ): Effect.Effect<void, ChangeVolumeFilesError, RuntimeContext>;
}

/** Read and write access to one volume's files. */
export interface ReadWriteVolumeClient extends ReadVolumeClient, WriteVolumeClient {}

/** The read half of a volume client over `volumeId`. */
export const makeReadVolumeClient = (
  volumeId: Effect.Effect<string>,
  ops: VolumeFileOps,
): ReadVolumeClient => ({
  volumeId,
  readFile: (path) => Effect.flatMap(volumeId, (id) => readVolumeFile(ops, id, path)),
  readFileString: (path) =>
    Effect.flatMap(volumeId, (id) => readVolumeFile(ops, id, path)).pipe(
      Effect.map((bytes) => new TextDecoder().decode(bytes)),
    ),
  listFiles: (path, options) =>
    Effect.flatMap(volumeId, (id) => listVolumeFiles(ops, id, path, options)),
});

/** The write half of a volume client over `volumeId`. */
export const makeWriteVolumeClient = (
  volumeId: Effect.Effect<string>,
  ops: VolumeFileOps,
): WriteVolumeClient => ({
  volumeId,
  writeFile: (path, data, options) =>
    Effect.flatMap(volumeId, (id) => writeVolumeFile(ops, id, path, data, options)),
  removeFile: (path, options) =>
    Effect.flatMap(volumeId, (id) => removeVolumeFile(ops, id, path, options)),
  copyFiles: (sources, destination, options) =>
    Effect.flatMap(volumeId, (id) => copyVolumeFiles(ops, id, sources, destination, options)),
});

/** A read-write volume client over `volumeId`. */
export const makeReadWriteVolumeClient = (
  volumeId: Effect.Effect<string>,
  ops: VolumeFileOps,
): ReadWriteVolumeClient => ({
  ...makeReadVolumeClient(volumeId, ops),
  ...makeWriteVolumeClient(volumeId, ops),
});
