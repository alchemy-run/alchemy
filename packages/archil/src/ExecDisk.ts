import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { DiskDelegationsClient, ExecDiskClient } from "./Clients.ts";
import type { Disk } from "./Disk.ts";

export type { DiskDelegationsClient, ExecDiskClient, ExecResult, GrepOptions } from "./Clients.ts";

/**
 * Run serverless commands against one disk, and search it, from a Worker,
 * Lambda, or any other host. Each `exec` boots a fresh microVM with the
 * disk mounted at `/mnt/archil`, runs the command to completion (up to five
 * minutes), and shuts down, so you pay only for the call. Files the command
 * writes stay on the disk.
 *
 * The host calls Archil with the API key you deploy with: Archil only
 * creates API keys from the console and can't scope them to one disk.
 *
 * ### Running Commands
 * **Example:** Count rows in a dataset from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const dataset = yield* Archil.ExecDisk(Dataset);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* dataset.exec("wc -l /mnt/archil/*.csv");
 *         return HttpServerResponse.text(result.stdout);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Archil.ExecDiskHttp)),
 * ) {}
 * ```
 *
 * ### Searching
 * **Example:** Grep the whole disk in constant time
 * ```typescript
 * const hits = yield* dataset.grep({ pattern: "TODO", directory: "src", recursive: true });
 * ```
 *
 * ### Recovering From a Crashed Mount
 * A mounted client holds write delegations on the paths it writes. When it
 * crashes without unmounting, reclaim them so other clients can write.
 *
 * **Example:** Revoke orphaned delegations
 * ```typescript
 * for (const d of yield* dataset.delegations()) {
 *   if (d.isOrphaned) yield* dataset.revokeDelegation(d);
 * }
 * ```
 *
 * @binding
 * @product Disk
 */
export interface ExecDisk extends Binding.Service<
  ExecDisk,
  "Archil.ExecDisk",
  (disk: Disk) => Effect.Effect<ExecDiskClient & DiskDelegationsClient>
> {}

export const ExecDisk = Binding.Service<ExecDisk>("Archil.ExecDisk");
