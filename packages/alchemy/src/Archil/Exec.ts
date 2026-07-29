import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ExecError, ExecResult } from "./Api.ts";
import type { Disk } from "./Disk.ts";

/**
 * Run a bash command in an ephemeral container with the bound disk mounted
 * at `/mnt/archil`. Non-zero exit codes are returned, not raised — only
 * transport/platform failures reach the error channel.
 */
export interface ExecClient {
  (command: string): Effect.Effect<ExecResult, ExecError, RuntimeContext>;
}

/**
 * Serverless execution on one `Archil.Disk` — a real OS with the disk's
 * filesystem mounted, from a Worker, a Lambda, or a script.
 *
 * Bind a disk declared at module scope, exactly like any other capability;
 * for disks only known at request time (one per user, per thread) use
 * {@link Connect} instead, which derives disks at request time.
 *
 * @binding
 * @section Running Commands
 * @example Bind a disk and run bash on it
 * ```typescript
 * // disks.ts
 * export const DataDisk = Archil.Disk("data");
 *
 * // worker.ts — init
 * const exec = yield* Archil.Exec(DataDisk);
 *
 * // request time
 * const { stdout, exitCode } = yield* exec("wc -l /mnt/archil/*.csv");
 * ```
 *
 * @example Exit codes are values, not failures
 * ```typescript
 * const { exitCode, stderr } = yield* exec("test -f /mnt/archil/ready");
 * if (exitCode !== 0) { ... }
 * ```
 *
 * @see https://docs.archil.com/compute/serverless-execution
 */
export interface Exec extends Binding.Service<
  Exec,
  "Archil.Exec",
  (disk: Disk) => Effect.Effect<ExecClient>
> {}

export const Exec = Binding.Service<Exec>("Archil.Exec");
