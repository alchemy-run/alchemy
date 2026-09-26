import * as Effect from "effect/Effect";
import { quote, type ExecOptions, type ExecResult } from "../Client.ts";
import {
  applied,
  converged,
  diverged,
  execute,
  type Step,
  type StepPolicy,
} from "../Recipe.ts";
import { parentOf, runOrFail } from "./internal.ts";

export interface StampInput extends Pick<
  ExecOptions,
  "sudo" | "cwd" | "env" | "timeout" | "shell"
> {
  name: string;
  /** Where the last applied value is recorded on the host. */
  path: string;
  /** The value `command` last ran for. Compared without surrounding whitespace. */
  value: string;
  command: string;
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

export interface StampOutput {
  value: string;
  result: ExecResult | undefined;
}

export const makeStampStep = (input: StampInput): Step<StampOutput> => {
  const step = { kind: "stamp", name: input.name };
  const value = input.value.trim();
  const path = quote(input.path);

  return {
    ...step,
    notify: input.notify,
    policy: input.policy,
    check: Effect.gen(function* () {
      const { stdout } = yield* runOrFail(
        step,
        `if [ -e ${path} ]; then cat -- ${path}; fi`,
        { sudo: input.sudo },
      );
      const recorded = stdout.trim();
      return recorded === value
        ? converged({ value, result: undefined })
        : diverged({ stamp: recorded }, { stamp: value });
    }),
    apply: Effect.gen(function* () {
      const result = yield* runOrFail(step, input.command, {
        sudo: input.sudo,
        cwd: input.cwd,
        env: input.env,
        timeout: input.timeout,
        shell: input.shell,
      });
      yield* runOrFail(
        step,
        `mkdir -p ${quote(parentOf(input.path))} && printf '%s\\n' ${quote(value)} > ${path}`,
        { sudo: input.sudo },
      );
      return applied({ value, result });
    }),
  };
};

/**
 * Run `command` whenever `value` differs from the one recorded at `path` the
 * last time it succeeded, e.g. restart a daemon for the config it last
 * loaded. Unlike a handler, a run that dies between the change and the
 * command still acts next time: the stamp is only written after the command
 * exits 0.
 */
export const stamp = (input: StampInput) => execute(makeStampStep(input));
