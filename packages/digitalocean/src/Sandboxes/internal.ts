import * as DO from "@distilled.cloud/digitalocean";
import type { Checkpoint2 as MicrovmCheckpoint, Microvm } from "@distilled.cloud/digitalocean";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { noneIfNotFound } from "../internal/notFound.ts";
import { pollUntil, type PollBudget } from "../internal/poll.ts";

export type { MicrovmCheckpoint, Microvm };

export class MicrovmWaitTimedOut extends Data.TaggedError("DigitalOcean.Sandboxes.WaitTimedOut")<{
  readonly id: string;
  readonly waitingFor: string;
  readonly lastState: string | undefined;
}> {
  override get message() {
    return `${this.id} timed out waiting for ${this.waitingFor} (last state: ${this.lastState ?? "missing"}).`;
  }
}

export class MicrovmFailed extends Data.TaggedError("DigitalOcean.Sandboxes.MicrovmFailed")<{
  readonly microvmId: string;
  readonly reason: string;
}> {
  override get message() {
    return `MicroVM ${this.microvmId} failed: ${this.reason}`;
  }
}

export class SetupCommandFailed extends Data.TaggedError(
  "DigitalOcean.Sandboxes.SetupCommandFailed",
)<{
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message() {
    return `Setup command '${this.command}' exited ${this.exitCode}: ${this.stderr}`;
  }
}

// A MicroVM boots in seconds; pulling a large image takes a minute or two.
const BOOT_POLL: PollBudget = { maxDelay: "5 seconds", times: 40 };

export const observeMicrovm = (microvmId: string) =>
  noneIfNotFound(DO.getMicrovm({ microvm_id: microvmId }).pipe(Effect.map((r) => r.microvm)));

export const observeCheckpoint = (checkpointId: string) =>
  noneIfNotFound(
    DO.getMicrovmCheckpoint({ checkpoint_id: checkpointId }).pipe(Effect.map((r) => r.checkpoint)),
  );

export const waitUntilRunning = (microvmId: string) =>
  pollUntil(observeMicrovm(microvmId), {
    ...BOOT_POLL,
    until: (o): o is Option.Some<Microvm> =>
      Option.isSome(o) && (o.value.state === "running" || o.value.state === "failed"),
    onTimeout: (last) =>
      new MicrovmWaitTimedOut({
        id: microvmId,
        waitingFor: "the running state",
        lastState: Option.getOrUndefined(last)?.state,
      }),
  }).pipe(
    Effect.flatMap(({ value }) =>
      value.state === "running"
        ? Effect.succeed(value)
        : Effect.fail(
            new MicrovmFailed({ microvmId, reason: value.failure_reason ?? "unknown reason" }),
          ),
    ),
  );

export const waitUntilGone = (microvmId: string) =>
  pollUntil(observeMicrovm(microvmId), {
    ...BOOT_POLL,
    until: (o) => Option.isNone(o) || o.value.state === "terminated",
    onTimeout: (last) =>
      new MicrovmWaitTimedOut({
        id: microvmId,
        waitingFor: "deletion",
        lastState: Option.getOrUndefined(last)?.state,
      }),
  });

export const deleteMicrovm = (microvmId: string) =>
  DO.deleteMicrovm({ microvm_id: microvmId }).pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.andThen(waitUntilGone(microvmId)),
  );

/** Runs one shell line in a MicroVM and fails on a non-zero exit. */
export const runSetup = Effect.fn(function* (microvmId: string, command: string) {
  const result = yield* DO.runMicrovmCommand({
    microvm_id: microvmId,
    argv: ["/bin/sh", "-lc", command],
  });
  if (result.exit_code !== 0) {
    return yield* new SetupCommandFailed({
      command,
      exitCode: result.exit_code,
      stderr: result.stderr,
    });
  }
});

/** The public HTTPS URL of a MicroVM's exposed port, if it has one. */
export const urlOf = (microvm: Microvm) => {
  const url = microvm.urls?.find((u) => u.default) ?? microvm.urls?.[0];
  return url?.hostname === undefined ? undefined : `https://${url.hostname}`;
};

/** App Platform style idle pause: pause after `seconds` idle, resume on request. */
export const autoPauseOf = (seconds: number | undefined) =>
  seconds === undefined ? undefined : { enabled: true, idle_timeout: `${seconds}s` };

/** The region MicroVMs go to when none is given: the account's default. */
export const defaultRegion = (region: string | undefined) =>
  region !== undefined
    ? Effect.succeed(region)
    : DO.getMicrovmOptions({}).pipe(Effect.map((options) => options.default_region));

/** A MicroVM size: one of the vCPU and memory (MiB) pairs DigitalOcean offers. */
export type SandboxSize =
  | { readonly cpu: 1; readonly memory: 2048 }
  | { readonly cpu: 2; readonly memory: 4096 }
  | { readonly cpu: 8; readonly memory: 16384 }
  | { readonly cpu: 16; readonly memory: 32768 };

/** The size a MicroVM gets when none is given: 1 vCPU, 2 GiB. */
export const sizeOf = (size: SandboxSize | undefined) => size ?? { cpu: 1, memory: 2048 };
