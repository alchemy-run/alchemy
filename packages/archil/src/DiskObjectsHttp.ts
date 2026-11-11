import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DiskKeyAccess } from "./ArchilBindings.ts";
import { makeReadDiskClient, makeWriteDiskClient, presignedShare } from "./Clients.ts";
import type { Disk } from "./Disk.ts";
import { ReadDisk, type DiskObjectsOptions } from "./ReadDisk.ts";
import { ReadWriteDisk } from "./ReadWriteDisk.ts";
import { WriteDisk } from "./WriteDisk.ts";

const diskRef = Effect.fn(function* (disk: Disk, options: DiskObjectsOptions | undefined) {
  const diskId = yield* disk.diskId;
  return Effect.map(diskId, (id) => ({ disk: id, branch: options?.branch }));
});

/**
 * {@link ReadDisk} over Archil's S3-compatible API, usable from any host.
 * The host gets a read-only S3 user on the disk.
 */
export const ReadDiskHttp = Layer.effect(
  ReadDisk,
  Effect.gen(function* () {
    const keys = yield* DiskKeyAccess;
    return Effect.fn(function* (disk: Disk, options?: DiskObjectsOptions) {
      const ref = yield* diskRef(disk, options);
      const run = yield* keys(disk, "read");
      return makeReadDiskClient(ref, run, presignedShare(run));
    });
  }),
);

/**
 * {@link WriteDisk} over Archil's S3-compatible API, usable from any host.
 * The host gets a read-write S3 user on the disk.
 */
export const WriteDiskHttp = Layer.effect(
  WriteDisk,
  Effect.gen(function* () {
    const keys = yield* DiskKeyAccess;
    return Effect.fn(function* (disk: Disk, options?: DiskObjectsOptions) {
      const ref = yield* diskRef(disk, options);
      const run = yield* keys(disk, "write");
      return makeWriteDiskClient(ref, run);
    });
  }),
);

/**
 * {@link ReadWriteDisk} over Archil's S3-compatible API, usable from any
 * host. The host gets a read-write S3 user on the disk.
 */
export const ReadWriteDiskHttp = Layer.effect(
  ReadWriteDisk,
  Effect.gen(function* () {
    const keys = yield* DiskKeyAccess;
    return Effect.fn(function* (disk: Disk, options?: DiskObjectsOptions) {
      const ref = yield* diskRef(disk, options);
      const run = yield* keys(disk, "write");
      return {
        ...makeReadDiskClient(ref, run, presignedShare(run)),
        ...makeWriteDiskClient(ref, run),
      };
    });
  }),
);
