import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ApiAccess } from "./ArchilBindings.ts";
import { makeBranchDiskClient, type BranchDiskClient } from "./Clients.ts";
import type { Disk } from "./Disk.ts";

export type { BranchDiskClient } from "./Clients.ts";

/**
 * Fork one disk per session or task at run time: each branch is an
 * independent, writable copy started from a committed checkpoint in about
 * 35 ms, whatever the disk's size. Seed the disk once at deploy time with an
 * {@link Checkpoint}, then branch from it per request.
 *
 * Mount a branch on your own machines with `MountDisk` and `branch`.
 * Branches share the disk's credentials. Sandboxes can't mount a branch.
 *
 * ### Branching per Session
 * **Example:** A fresh workspace for every session
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const seeds = yield* Archil.BranchDisk(Seed);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const branch = yield* seeds.branch({ name: "session-42", fromCheckpoint: "base" });
 *         return yield* HttpServerResponse.json(branch);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Archil.BranchDiskHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Disk
 */
export interface BranchDisk extends Binding.Service<
  BranchDisk,
  "Archil.BranchDisk",
  (disk: Disk) => Effect.Effect<BranchDiskClient>
> {}

export const BranchDisk = Binding.Service<BranchDisk>("Archil.BranchDisk");

/** {@link BranchDisk} over Archil's HTTP API, usable from any host. */
export const BranchDiskHttp = Layer.effect(
  BranchDisk,
  Effect.gen(function* () {
    const access = yield* ApiAccess;
    return Effect.fn(function* (disk: Disk) {
      return makeBranchDiskClient(yield* disk.diskId, yield* access());
    });
  }),
);
