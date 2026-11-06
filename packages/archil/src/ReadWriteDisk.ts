import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ReadWriteDiskClient } from "./Clients.ts";
import type { Disk } from "./Disk.ts";
import type { DiskObjectsOptions } from "./ReadDisk.ts";

export type { ReadWriteDiskClient } from "./Clients.ts";

/**
 * Read and write a disk's files as objects: everything {@link ReadDisk}
 * and {@link WriteDisk} do, in one client. The host gets its own
 * read-write S3 user on this disk, and never holds an API key.
 *
 * ### Reading and Writing
 * **Example:** Upload, then hand out a link
 * ```typescript
 * const files = yield* Archil.ReadWriteDisk(Dataset);
 * yield* files.put("uploads/photo.jpg", bytes, { contentType: "image/jpeg" });
 * const url = yield* files.share("uploads/photo.jpg", 600);
 * ```
 *
 * @binding
 * @product Disk
 */
export interface ReadWriteDisk extends Binding.Service<
  ReadWriteDisk,
  "Archil.ReadWriteDisk",
  (disk: Disk, options?: DiskObjectsOptions) => Effect.Effect<ReadWriteDiskClient>
> {}

export const ReadWriteDisk = Binding.Service<ReadWriteDisk>("Archil.ReadWriteDisk");
