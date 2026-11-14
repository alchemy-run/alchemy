import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Volume } from "./Volume.ts";
import type { ReadWriteVolumeClient } from "./VolumeClient.ts";

export type { ReadWriteVolumeClient } from "./VolumeClient.ts";

/**
 * Read and write a Modal Volume's files from any runtime without mounting it.
 *
 * ### Bind a volume
 * **Example:** ReadWrite from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Workspace } from "./Storage.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const volume = yield* Modal.ReadWriteVolume(Workspace);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* volume.writeFile("/hello.txt", "hello");
 *         const text = yield* volume.readFileString("/hello.txt");
 *         return HttpServerResponse.text(text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.ReadWriteVolumeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Volume
 */
export interface ReadWriteVolume extends Binding.Service<
  ReadWriteVolume,
  "Modal.ReadWriteVolume",
  (volume: Volume) => Effect.Effect<ReadWriteVolumeClient>
> {}

export const ReadWriteVolume = Binding.Service<ReadWriteVolume>("Modal.ReadWriteVolume");
