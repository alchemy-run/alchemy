import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Volume } from "./Volume.ts";
import type { WriteVolumeClient } from "./VolumeClient.ts";

export type { WriteVolumeClient } from "./VolumeClient.ts";

/**
 * Write a Modal Volume's files from any runtime without mounting it: upload, remove and copy files over Modal's volume API. Sandboxes that mount the volume see the changes after they reload it.
 *
 * ### Bind a volume
 * **Example:** Write from a Cloudflare Worker
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
 *     const volume = yield* Modal.WriteVolume(Workspace);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* volume.writeFile("/inbox/task.json", JSON.stringify({ repo: "alchemy" }));
 *         return HttpServerResponse.text("written");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.WriteVolumeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Volume
 */
export interface WriteVolume extends Binding.Service<
  WriteVolume,
  "Modal.WriteVolume",
  (volume: Volume) => Effect.Effect<WriteVolumeClient>
> {}

export const WriteVolume = Binding.Service<WriteVolume>("Modal.WriteVolume");
