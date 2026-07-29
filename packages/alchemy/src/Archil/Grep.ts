import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { GrepError, GrepRequest, GrepResult } from "./Api.ts";
import type { Disk } from "./Disk.ts";

/**
 * Parallel `grep -E` over files on the bound disk, fanned out across
 * ephemeral containers. Read-only.
 */
export interface GrepClient {
  (request: GrepRequest): Effect.Effect<GrepResult, GrepError, RuntimeContext>;
}

/**
 * Parallel search across one `Archil.Disk` — the read-only sibling of
 * {@link Exec}, for when the disk is bigger than a single container can
 * scan inside the request budget.
 *
 * @binding
 * @section Searching Files
 * @example Bind a disk and search it
 * ```typescript
 * const grep = yield* Archil.Grep(DataDisk);
 *
 * const { matches, stoppedReason } = yield* grep({
 *   directory: "logs",
 *   pattern: "ERROR|FATAL",
 *   recursive: true,
 * });
 * ```
 * `stoppedReason` distinguishes a complete scan from one cut short by
 * `maxResults` or the deadline — check it before trusting an empty result.
 *
 * @see https://docs.archil.com/compute/search-files
 */
export interface Grep extends Binding.Service<
  Grep,
  "Archil.Grep",
  (disk: Disk) => Effect.Effect<GrepClient>
> {}

export const Grep = Binding.Service<Grep>("Archil.Grep");
