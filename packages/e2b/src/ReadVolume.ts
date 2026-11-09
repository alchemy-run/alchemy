import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Volume } from "./Volume.ts";
import type { ReadVolumeClient } from "./VolumeFiles.ts";

/**
 * Read a {@link Volume}'s files from outside any sandbox: a report a sandbox wrote, a dataset to inspect.
 *
 * The client talks to E2B's volume content API with the volume's own token,
 * looked up once through the host's API key.
 *
 * ### Using the client
 * **Example:** In a Worker
 * ```typescript
 * const reports = yield* E2B.ReadVolume(Reports);
 * // in fetch:
 * const report = yield* reports.readText("/report.json");
 * ```
 *
 * @binding
 * @product Volume
 */
export interface ReadVolume extends Binding.Service<
  ReadVolume,
  "E2B.ReadVolume",
  (volume: Volume) => Effect.Effect<ReadVolumeClient>
> {}

export const ReadVolume = Binding.Service<ReadVolume>("E2B.ReadVolume");
