import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { WriteDiskClient } from "./Clients.ts";
import type { Disk } from "./Disk.ts";
import type { DiskObjectsOptions } from "./ReadDisk.ts";

export type { WriteDiskClient } from "./Clients.ts";

/**
 * Write a disk's files as objects over Archil's S3-compatible API: put,
 * append, copy, delete, and multipart uploads of any size. The host gets
 * its own read-write S3 user on this disk, so it can't reach any other
 * disk and never holds an API key. A write that conflicts with a mounted
 * client's write delegation fails with `ObjectConflict`; `ExecDisk`'s
 * `delegations` and `revokeDelegation` reclaim paths a crashed client
 * still holds.
 *
 * ### Writing Files
 * **Example:** Append events to a log on a disk
 * ```typescript
 * const files = yield* Archil.WriteDisk(Dataset);
 * yield* files.append("events.ndjson", JSON.stringify(event) + "\n");
 * ```
 *
 * ### Uploading Large Files
 * **Example:** Stream a file of any size onto the disk
 * ```typescript
 * const files = yield* Archil.WriteDisk(Dataset);
 * const request = yield* HttpServerRequest;
 * yield* files.upload("uploads/video.mp4", request.stream, { contentType: "video/mp4" });
 * ```
 *
 * @binding
 * @product Disk
 */
export interface WriteDisk extends Binding.Service<
  WriteDisk,
  "Archil.WriteDisk",
  (disk: Disk, options?: DiskObjectsOptions) => Effect.Effect<WriteDiskClient>
> {}

export const WriteDisk = Binding.Service<WriteDisk>("Archil.WriteDisk");
