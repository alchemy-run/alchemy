import * as Effect from "effect/Effect";
import { quote } from "../Client.ts";
import {
  applied,
  converged,
  diverged,
  execute,
  StepFailed,
  type Step,
  type StepPolicy,
} from "../Recipe.ts";
import {
  declaredOwnership,
  inspect,
  ownershipCommands,
  ownershipDiff,
  runOrFail,
  type Ownership,
} from "./internal.ts";

export interface DirectoryInput extends Ownership {
  path: string;
  /** `"absent"` removes the directory and everything in it. @default "present" */
  state?: "present" | "absent";
  sudo?: boolean;
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

export interface DirectoryOutput {
  path: string;
}

export const makeDirectoryStep = (
  input: DirectoryInput,
): Step<DirectoryOutput> => {
  const step = { kind: "directory", name: input.path };
  const options = { sudo: input.sudo };
  const output = { path: input.path };

  return {
    ...step,
    notify: input.notify,
    policy: input.policy,
    check: Effect.gen(function* () {
      const actual = yield* inspect(step, input.path, options);
      if (actual !== undefined && actual.type !== "directory") {
        return yield* new StepFailed({
          message: `directory[${input.path}]: exists and is not a directory`,
          ...step,
          step: step.name,
        });
      }
      if (input.state === "absent") {
        return actual === undefined
          ? converged(output)
          : diverged({ state: "present" }, { state: "absent" });
      }
      if (actual === undefined) {
        return diverged(
          { state: "absent" },
          { state: "present", ...declaredOwnership(input) },
        );
      }
      const ownership = ownershipDiff(input, actual);
      return ownership.differs
        ? diverged(ownership.current, ownership.desired)
        : converged(output);
    }),
    apply: Effect.gen(function* () {
      yield* runOrFail(
        step,
        input.state === "absent"
          ? `rm -rf ${quote(input.path)}`
          : [
              "set -e",
              `mkdir -p ${quote(input.path)}`,
              ...ownershipCommands(input.path, input),
            ].join("\n"),
        options,
      );
      return applied(output);
    }),
  };
};

/** A directory with this ownership. */
export const directory = (input: DirectoryInput) =>
  execute(makeDirectoryStep(input));
