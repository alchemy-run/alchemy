import type * as volumeContent from "@distilled.cloud/e2b/volume_content";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { E2BError } from "./SandboxClient.ts";

/** A file, directory or symlink in a volume. */
export type VolumeEntry = volumeContent.VolumeEntryStat;

/** Ownership and permissions for a written file or directory. */
export interface VolumeEntryOptions {
  readonly uid?: number;
  readonly gid?: number;
  /** POSIX mode, e.g. `0o644`. */
  readonly mode?: number;
}

/** Read a volume's files without a sandbox. Paths are absolute inside the volume. */
export interface ReadVolumeClient {
  read(path: string): Effect.Effect<Uint8Array, E2BError, RuntimeContext>;
  readText(path: string): Effect.Effect<string, E2BError, RuntimeContext>;
  /** Directory entries, `depth` levels deep. */
  list(
    path: string,
    options?: { readonly depth?: number },
  ): Effect.Effect<ReadonlyArray<VolumeEntry>, E2BError, RuntimeContext>;
  stat(path: string): Effect.Effect<VolumeEntry, E2BError, RuntimeContext>;
  exists(path: string): Effect.Effect<boolean, E2BError, RuntimeContext>;
}

/** Write a volume's files without a sandbox. Paths are absolute inside the volume. */
export interface WriteVolumeClient {
  /** Writes a file, creating parent directories. */
  write(
    path: string,
    data: string | Uint8Array,
    options?: VolumeEntryOptions,
  ): Effect.Effect<VolumeEntry, E2BError, RuntimeContext>;
  /** Creates a directory and its parents. */
  makeDir(
    path: string,
    options?: VolumeEntryOptions,
  ): Effect.Effect<VolumeEntry, E2BError, RuntimeContext>;
  /** Changes ownership or mode. */
  chmod(
    path: string,
    options: VolumeEntryOptions,
  ): Effect.Effect<VolumeEntry, E2BError, RuntimeContext>;
  /** Removes a file or a directory tree. Removing a missing path succeeds. */
  remove(path: string): Effect.Effect<void, E2BError, RuntimeContext>;
}

/** Read and write a volume's files without a sandbox. */
export interface ReadWriteVolumeClient extends ReadVolumeClient, WriteVolumeClient {}
