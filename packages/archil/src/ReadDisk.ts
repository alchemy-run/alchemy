import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ReadDiskClient } from "./Clients.ts";
import type { Disk } from "./Disk.ts";

export type { ReadDiskClient } from "./Clients.ts";

/** Options for the object bindings. */
export interface DiskObjectsOptions {
  /** Read or write a branch of the disk instead of its root. */
  branch?: string;
}

/**
 * Read a disk's files as objects over Archil's S3-compatible API, with no
 * machine and no mount: get, stream, head, list, and presigned share URLs.
 * Reads see what mounted clients have written.
 *
 * The host gets its own read-only S3 user on this disk: its keys can only
 * `GET` and `HEAD` this disk's files, and the host never holds an API key.
 * Destroying the stack revokes the user.
 *
 * ### Reading Files
 * **Example:** Serve files from a disk in a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const files = yield* Archil.ReadDisk(Dataset);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const readme = yield* files.getText("README.md");
 *         return HttpServerResponse.text(readme);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Archil.ReadDiskHttp)),
 * ) {}
 * ```
 *
 * **Example:** Stream a large file to the response
 * ```typescript
 * return HttpServerResponse.stream(files.getStream("exports/data.parquet"));
 * ```
 *
 * ### Sharing Files
 * **Example:** A one-hour download link
 * ```typescript
 * const url = yield* files.share("reports/2026-11.pdf", 3600);
 * ```
 *
 * @binding
 * @product Disk
 */
export interface ReadDisk extends Binding.Service<
  ReadDisk,
  "Archil.ReadDisk",
  (disk: Disk, options?: DiskObjectsOptions) => Effect.Effect<ReadDiskClient>
> {}

export const ReadDisk = Binding.Service<ReadDisk>("Archil.ReadDisk");
