import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { GrepError, GrepRequest, GrepResult } from "./Api.ts";
import type { Disk } from "./Disk.ts";

export type {
  GrepError,
  GrepMatch,
  GrepRequest,
  GrepResult,
  GrepStoppedReason,
} from "./Api.ts";

/**
 * Parallel, read-only search over files on an Archil {@link Disk}.
 *
 * Binding a disk returns a callable that fans `grep -E` out across ephemeral
 * exec containers, so even large directories finish inside the request's
 * time budget. Three knobs control cost and latency: `maxDurationSeconds`
 * (wall-clock deadline, capped at 30s), `concurrency` (parallel workers),
 * and `maxResults` (short-circuit). The response's `stoppedReason`
 * distinguishes complete scans from early termination.
 *
 * This capability is read-only — bind it instead of {@link Exec} when a
 * consumer should search but never mutate the disk.
 *
 * @binding
 * @section Searching Files
 * @example Search logs from a Worker or Lambda
 * ```typescript
 * const grep = yield* Archil.Grep(disk);
 *
 * const { matches, stoppedReason } = yield* grep({
 *   directory: "logs",
 *   pattern: "ERROR|FATAL",
 *   recursive: true,
 * });
 * ```
 *
 * @example Bounded search with early exit
 * ```typescript
 * const grep = yield* Archil.Grep(disk);
 *
 * const result = yield* grep({
 *   directory: "",
 *   pattern: "TODO",
 *   recursive: true,
 *   maxResults: 100,
 *   maxDurationSeconds: 10,
 * });
 * ```
 *
 * @see https://docs.archil.com/compute/search-files
 */
export interface Grep extends Binding.Service<
  Grep,
  "Archil.Grep",
  (
    disk: Disk,
  ) => Effect.Effect<
    (
      request: GrepRequest,
    ) => Effect.Effect<GrepResult, GrepError, RuntimeContext>
  >
> {}

export const Grep = Binding.Service<Grep>("Archil.Grep");
