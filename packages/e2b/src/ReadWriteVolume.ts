import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Volume } from "./Volume.ts";
import type { ReadWriteVolumeClient } from "./VolumeFiles.ts";

/**
 * Read and write a {@link Volume}'s files from outside any sandbox.
 *
 * The client talks to E2B's volume content API with the volume's own token,
 * looked up once through the host's API key.
 *
 * ### Using the client
 * **Example:** In a Worker
 * ```typescript
 * const cache = yield* E2B.ReadWriteVolume(Cache);
 * // in fetch:
 * yield* cache.write("/notes.md", "hello");
 * const notes = yield* cache.readText("/notes.md");
 * ```
 *
 * @binding
 * @product Volume
 */
export interface ReadWriteVolume extends Binding.Service<
  ReadWriteVolume,
  "E2B.ReadWriteVolume",
  (volume: Volume) => Effect.Effect<ReadWriteVolumeClient>
> {}

export const ReadWriteVolume = Binding.Service<ReadWriteVolume>("E2B.ReadWriteVolume");
