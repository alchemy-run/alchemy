import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Volume } from "./Volume.ts";
import type { WriteVolumeClient } from "./VolumeFiles.ts";

/**
 * Write a {@link Volume}'s files from outside any sandbox: seed inputs before sandboxes start, or clean up after them.
 *
 * The client talks to E2B's volume content API with the volume's own token,
 * looked up once through the host's API key.
 *
 * ### Using the client
 * **Example:** In a Worker
 * ```typescript
 * const inputs = yield* E2B.WriteVolume(Inputs);
 * // in fetch:
 * yield* inputs.write("/task.json", JSON.stringify(task));
 * ```
 *
 * @binding
 * @product Volume
 */
export interface WriteVolume extends Binding.Service<
  WriteVolume,
  "E2B.WriteVolume",
  (volume: Volume) => Effect.Effect<WriteVolumeClient>
> {}

export const WriteVolume = Binding.Service<WriteVolume>("E2B.WriteVolume");
