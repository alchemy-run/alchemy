import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { CommonError, DiskNotFound, NoCheckpoint } from "./Api.ts";
import type { DiskConnection } from "./Connect.ts";
import type { Disk } from "./Disk.ts";

/**
 * Fork a named, writable copy of the bound disk and connect to it.
 *
 * Forking is copy-on-write: the branch starts from a checkpoint of the base
 * disk, and writes on it are isolated from the base and from every sibling
 * fork. This is the cheap way to hand each user, agent, or thread its own
 * copy of a baked base image.
 *
 * Idempotent by name — an existing fork is returned rather than re-created,
 * so the same call serves first touch and every request after.
 *
 * With no `from`, the disk's newest `committed` checkpoint is used, failing
 * with `NoCheckpoint` if it has none. Checkpoints are taken from a mounted
 * disk (`archil checkpoints create <mountpoint> <name>`); the control plane
 * exposes no route for creating them, so bake them out-of-band.
 *
 * Forks cannot be deleted — Archil exposes no delete route for branches —
 * and a fork is not a security boundary: the base disk's credentials cover
 * all of its forks.
 */
export interface ForkClient {
  (
    name: string,
    options?: {
      /** Checkpoint to fork from. @default the newest committed checkpoint */
      from?: string;
      /** Branch the checkpoint was taken on. Omit for the root branch. */
      fromBranch?: string;
    },
  ): Effect.Effect<
    DiskConnection,
    DiskNotFound | NoCheckpoint | CommonError,
    RuntimeContext
  >;
}

/**
 * Fork copies of an `Archil.Disk` at runtime — one per user, agent, or
 * thread, each starting from the base disk's contents.
 *
 * @binding
 * @section Forking a Base Image
 * @example One fork per user
 * Bake and checkpoint the base out-of-band (checkpoints need a mounted
 * disk — a build box or CI step, not a Worker):
 * ```bash
 * sudo archil mount myorg/base /mnt/archil --region aws-us-east-1
 * # …install deps, seed data…
 * archil checkpoints create /mnt/archil golden-v1
 * ```
 * Then fork per user at request time — the fork is a full connection, so
 * you can run commands on it immediately:
 * ```typescript
 * // disks.ts
 * export const BaseDisk = Archil.Disk("base");
 *
 * // worker.ts — init
 * const exec = yield* Archil.Exec(BaseDisk);
 * const fork = yield* Archil.Fork(BaseDisk);
 *
 * // request time
 * yield* exec("ls /mnt/archil");                 // the base image
 * const workspace = yield* fork(`user-${userId}`);
 * yield* workspace.exec("python3 /mnt/archil/run.py");
 * ```
 *
 * @example Pin a specific checkpoint
 * ```typescript
 * const workspace = yield* fork(`user-${userId}`, { from: "golden-v1" });
 * ```
 *
 * @see https://docs.archil.com/concepts/branches-and-checkpoints
 */
export interface Fork extends Binding.Service<
  Fork,
  "Archil.Fork",
  (disk: Disk) => Effect.Effect<ForkClient>
> {}

export const Fork = Binding.Service<Fork>("Archil.Fork");
