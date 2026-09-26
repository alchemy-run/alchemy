import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ExecOptions, ExecResult } from "../Client.ts";
import {
  applied,
  converged,
  diverged,
  execute,
  StepFailed,
  type Step,
  type StepPolicy,
} from "../Recipe.ts";
import { clientExec } from "./internal.ts";

export interface WaitForInput extends Pick<
  ExecOptions,
  "sudo" | "cwd" | "env" | "shell"
> {
  name: string;
  /** The probe. It runs repeatedly, so it must be safe to repeat. */
  command: string;
  /** Whether the probe result satisfies the wait. @default exit code 0 */
  until?: (result: ExecResult) => boolean;
  /** Fail at once, without waiting for the deadline, when this holds. */
  abortWhen?: (result: ExecResult) => boolean;
  timeout: Duration.Input;
  /** @default "10 seconds" */
  interval?: Duration.Input;
  /** Added to the failure message when the deadline passes. */
  onTimeout?: string;
  policy?: StepPolicy;
}

class NotYet extends Data.TaggedError("NotYet")<{ result: ExecResult }> {}

export const makeWaitForStep = (input: WaitForInput): Step<ExecResult> => {
  const step = { kind: "waitFor", name: input.name };
  const satisfied = input.until ?? ((result: ExecResult) => result.code === 0);
  const interval = input.interval ?? "10 seconds";
  const failed = (message: string, result: ExecResult) =>
    new StepFailed({
      message: `waitFor[${input.name}]: ${message}`,
      kind: step.kind,
      step: step.name,
      command: input.command,
      ...result,
    });
  // Each probe is bounded by the interval, so a hung probe cannot outlive
  // the deadline.
  const probe = Effect.flatMap(clientExec, (run) =>
    run(input.command, {
      sudo: input.sudo,
      cwd: input.cwd,
      env: input.env,
      shell: input.shell,
      timeout: interval,
    }),
  );

  return {
    ...step,
    policy: input.policy,
    verify: false,
    check: Effect.map(probe, (result) =>
      satisfied(result)
        ? converged(result)
        : diverged({ ready: false, code: result.code }, { ready: true }),
    ),
    apply: Effect.gen(function* () {
      const attempt = Effect.gen(function* () {
        const result = yield* probe;
        if (satisfied(result)) return result;
        if (input.abortWhen?.(result)) {
          return yield* failed("condition can no longer be met", result);
        }
        return yield* new NotYet({ result });
      });
      const result = yield* attempt.pipe(
        Effect.retry({
          while: (error) =>
            error._tag === "NotYet" || error._tag === "Ssh.ExecTimeout",
          schedule: Schedule.spaced(interval).pipe(
            Schedule.upTo({ duration: input.timeout }),
          ),
        }),
        Effect.catchTag("NotYet", (error) =>
          Effect.fail(
            failed(
              `condition not met within ${Duration.format(Duration.fromInputUnsafe(input.timeout))}${input.onTimeout === undefined ? "" : `: ${input.onTimeout}`}`,
              error.result,
            ),
          ),
        ),
      );
      return applied(result);
    }),
  };
};

/**
 * Poll a probe until it reports the condition holds, e.g. a health check
 * after a deploy. `check` probes once, so a dry run reports whether the
 * condition holds now.
 */
export const waitFor = (input: WaitForInput) => execute(makeWaitForStep(input));
