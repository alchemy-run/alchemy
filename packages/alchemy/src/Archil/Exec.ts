import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ExecError, ExecResult } from "./Api.ts";
import type { Disk } from "./Disk.ts";

export type { ExecError, ExecResult, ExecTiming } from "./Api.ts";

/**
 * Run bash commands on an Archil {@link Disk} without provisioning compute.
 *
 * Binding a disk returns a callable that launches an ephemeral container
 * with the disk mounted at `/mnt/archil`, runs the command via `bash -c` on
 * a real OS (coreutils, grep, sed, awk, find, curl, jq, python3, node), and
 * returns stdout, stderr, the exit code, and timing. Billing covers only
 * `timing.executeMs`, in 1ms increments (100ms minimum).
 *
 * The runtime call is plain HTTPS, so the same binding works from Cloudflare
 * Workers, AWS Lambda, and any other Alchemy host. Provide {@link ExecHttp}
 * (mints a dedicated Archil API token per host) or {@link ExecLocal}
 * (ambient CLI credentials, for scripts and Actions).
 *
 * Requires the disk to live in an exec-enabled region (`aws-us-east-1`,
 * `aws-us-west-2`, `aws-eu-west-1`); other regions fail with the typed
 * `ExecNotEnabled` error. Commands time out after 5 minutes; stdout/stderr
 * are each capped at 128 KiB.
 *
 * @binding
 * @section Executing Commands
 * @example Run bash on a disk from a Worker or Lambda
 * ```typescript
 * const run = yield* Archil.Exec(disk);
 *
 * const { stdout, exitCode } = yield* run("ls -la /mnt/archil");
 * ```
 *
 * @example Aggregate data server-side
 * ```typescript
 * const run = yield* Archil.Exec(disk);
 *
 * const { stdout } = yield* run(
 *   "cat /mnt/archil/logs/*.log | grep ERROR | wc -l",
 * );
 * ```
 *
 * @example Write then execute a script
 * ```typescript
 * const run = yield* Archil.Exec(disk);
 *
 * yield* run("printf '%s' 'print(40 + 2)' > /mnt/archil/job.py");
 * const { stdout } = yield* run("python3 /mnt/archil/job.py");
 * ```
 *
 * @see https://docs.archil.com/compute/serverless-execution
 */
export interface Exec extends Binding.Service<
  Exec,
  "Archil.Exec",
  (
    disk: Disk,
  ) => Effect.Effect<
    (command: string) => Effect.Effect<ExecResult, ExecError, RuntimeContext>
  >
> {}

export const Exec = Binding.Service<Exec>("Archil.Exec");
