import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ExecError, ExecResult } from "./Api.ts";
import type { Disk } from "./Disk.ts";

/**
 * A disk to mount for a multi-disk exec: either a bare {@link Disk} (mounts
 * the disk root read-write) or a spec selecting a subdirectory and/or
 * marking the mount read-only.
 */
export type MultiExecMount =
  | Disk
  | {
      disk: Disk;
      /** Subdirectory of the disk to expose (relative, no `.`/`..`). */
      subdirectory?: string;
      /** Mount read-only — writes fail with EROFS. @default false */
      readOnly?: boolean;
    };

/**
 * Map of relative path under `/mnt/archil` to the disk mounted there.
 * Paths must be non-empty, non-absolute, and contain no `.`/`..` segments.
 */
export type MultiExecMounts = Record<string, MultiExecMount>;

/**
 * Run bash commands with multiple Archil {@link Disk}s mounted at once.
 *
 * Binding a mount map returns a callable that launches an ephemeral
 * container with every disk mounted at `/mnt/archil/<key>` (activation is
 * atomic — every disk mounts or none do), runs the command via `bash -c`,
 * and returns stdout, stderr, exit code, and timing. All disks must live in
 * the same exec-enabled region.
 *
 * Provide {@link MultiExecHttp} for deployed Functions/Workers or
 * {@link MultiExecLocal} for scripts and Actions.
 *
 * @binding
 * @section Executing Across Disks
 * @example Aggregate one disk into another
 * ```typescript
 * const run = yield* Archil.MultiExec({
 *   data: dataDisk,
 *   logs: { disk: logsDisk, subdirectory: "app", readOnly: true },
 * });
 *
 * const { stdout } = yield* run(
 *   "wc -l /mnt/archil/data/*.csv > /mnt/archil/data/lines.txt && cat /mnt/archil/data/lines.txt",
 * );
 * ```
 *
 * @see https://docs.archil.com/compute/serverless-execution
 */
export interface MultiExec extends Binding.Service<
  MultiExec,
  "Archil.MultiExec",
  (
    disks: MultiExecMounts,
  ) => Effect.Effect<
    (command: string) => Effect.Effect<ExecResult, ExecError, RuntimeContext>
  >
> {}

export const MultiExec = Binding.Service<MultiExec>("Archil.MultiExec");
