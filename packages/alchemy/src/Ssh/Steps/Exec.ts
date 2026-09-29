import * as Effect from "effect/Effect";
import { quote, type ExecOptions, type ExecResult } from "../Client.ts";
import {
  applied,
  converged,
  diverged,
  execute,
  skipped,
  type Step,
  type StepPolicy,
} from "../Recipe.ts";
import { clientExec, succeeded } from "./internal.ts";

export interface ExecInput extends ExecOptions {
  command: string;
  /** Shown in reports. @default the command, truncated */
  name?: string;
  /** Skip when this command exits 0. Read-only: it runs during dry runs. */
  unless?: string;
  /** Run only when this command exits 0. Read-only: it runs during dry runs. */
  onlyIf?: string;
  /** Skip when this path, or shell glob, exists. */
  creates?: string;
  /** Run only when this path (or glob) exists. */
  removes?: string;
  /**
   * Whether a run counts as a change, like Ansible's `changed_when`.
   * @default always
   */
  changed?: (result: ExecResult) => boolean;
  /** @default true */
  failOnNonZero?: boolean;
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

const NAME_LIMIT = 60;

// `ls -d` exits 0 when at least one match exists.
const exists = (path: string) =>
  /[*?[]/.test(path)
    ? `ls -d -- ${path} >/dev/null 2>&1`
    : `test -e ${quote(path)}`;

/** Each guard as a shell test that exits 0 when the command should be skipped. */
const skipConditions = (input: ExecInput) => [
  ...(input.unless === undefined ? [] : [input.unless]),
  ...(input.onlyIf === undefined ? [] : [`! { ${input.onlyIf}; }`]),
  ...(input.creates === undefined ? [] : [exists(input.creates)]),
  ...(input.removes === undefined ? [] : [`! ${exists(input.removes)}`]),
];

export const makeExecStep = (
  input: ExecInput,
): Step<ExecResult | undefined> => {
  const name =
    input.name ??
    (input.command.length > NAME_LIMIT
      ? `${input.command.slice(0, NAME_LIMIT - 1)}…`
      : input.command);
  const step = { kind: "exec", name };
  const options: ExecOptions = {
    sudo: input.sudo,
    cwd: input.cwd,
    env: input.env,
    timeout: input.timeout,
    shell: input.shell,
  };
  const guards = skipConditions(input);

  return {
    ...step,
    notify: input.notify,
    policy: input.policy,
    verify: false,
    check: Effect.gen(function* () {
      const run = yield* clientExec;
      for (const guard of guards) {
        if ((yield* run(guard, options)).code === 0) {
          return converged(undefined);
        }
      }
      return diverged({ executed: false }, { command: input.command });
    }),
    apply: Effect.gen(function* () {
      const run = yield* clientExec;
      const result = yield* run(input.command, {
        ...options,
        stdin: input.stdin,
      });
      if (input.failOnNonZero !== false) {
        yield* succeeded(step, input.command, result);
      }
      return input.changed === undefined || input.changed(result)
        ? applied(result)
        : skipped(result);
    }),
  };
};

/**
 * Run a shell command. `creates`, `removes`,
 * `unless` and `onlyIf` make it idempotent and are evaluated during `check`,
 * so a dry run reports what an apply would do. Without a guard the command
 * runs on every apply.
 */
export const exec = (input: ExecInput) => execute(makeExecStep(input));
