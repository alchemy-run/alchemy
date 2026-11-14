import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Volume } from "./Volume.ts";
import type { ReadVolumeClient } from "./VolumeClient.ts";

export type { ReadVolumeClient } from "./VolumeClient.ts";

/**
 * Read a Modal Volume's files from any runtime (a Worker, a Lambda, a Modal sandbox) without mounting it: list directories and read files over Modal's volume API.
 *
 * ### Bind a volume
 * **Example:** Read from a Cloudflare Worker
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
 *     const volume = yield* Modal.ReadVolume(Workspace);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const files = yield* volume.listFiles("/");
 *         const readme = yield* volume.readFileString("/README.md");
 *         return yield* HttpServerResponse.json({ files, readme });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.ReadVolumeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Volume
 */
export interface ReadVolume extends Binding.Service<
  ReadVolume,
  "Modal.ReadVolume",
  (volume: Volume) => Effect.Effect<ReadVolumeClient>
> {}

export const ReadVolume = Binding.Service<ReadVolume>("Modal.ReadVolume");
