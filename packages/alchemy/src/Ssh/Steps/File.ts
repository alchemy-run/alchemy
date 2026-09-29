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
import { sha256 } from "../../Util/sha256.ts";
import {
  declaredOwnership,
  inspect,
  ownershipDiff,
  runOrFail,
  writeScript,
  type WriteOptions,
} from "./internal.ts";

export interface FileInput extends WriteOptions {
  path: string;
  /** Required unless `state` is `"absent"`. */
  content?: string | Uint8Array;
  /** @default "present" */
  state?: "present" | "absent";
  sudo?: boolean;
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

export interface FileOutput {
  path: string;
  /** sha256 of the content; empty when absent. */
  checksum: string;
}

export const makeFileStep = (input: FileInput): Step<FileOutput> => {
  const step = { kind: "file", name: input.path };
  const options = { sudo: input.sudo };
  const content =
    typeof input.content === "string"
      ? new TextEncoder().encode(input.content)
      : input.content;
  const absent = { path: input.path, checksum: "" };

  return {
    ...step,
    notify: input.notify,
    policy: input.policy,
    check: Effect.gen(function* () {
      const actual = yield* inspect(step, input.path, {
        ...options,
        checksum: true,
      });
      if (actual !== undefined && actual.type !== "file") {
        return yield* new StepFailed({
          message: `file[${input.path}]: exists and is not a regular file`,
          ...step,
          step: step.name,
        });
      }
      if (input.state === "absent") {
        return actual === undefined
          ? converged(absent)
          : diverged({ state: "present" }, { state: "absent" });
      }
      if (content === undefined) {
        return yield* new StepFailed({
          message: `file[${input.path}]: content is required`,
          ...step,
          step: step.name,
        });
      }
      const checksum = yield* sha256(content);
      if (actual === undefined) {
        return diverged(
          { state: "absent" },
          { state: "present", checksum, ...declaredOwnership(input) },
        );
      }
      const ownership = ownershipDiff(input, actual);
      const same = actual.checksum === checksum;
      if (same && !ownership.differs) {
        return converged({ path: input.path, checksum });
      }
      return diverged(
        {
          ...(same ? {} : { checksum: actual.checksum }),
          ...ownership.current,
        },
        { ...(same ? {} : { checksum }), ...ownership.desired },
      );
    }),
    apply: Effect.gen(function* () {
      if (input.state === "absent") {
        yield* runOrFail(step, `rm -f ${quote(input.path)}`, options);
        return applied(absent);
      }
      yield* runOrFail(step, writeScript(input.path, input), {
        ...options,
        stdin: content,
      });
      return applied({ path: input.path, checksum: yield* sha256(content!) });
    }),
  };
};

/**
 * A file with exactly this content and ownership, like Ansible's `copy`.
 * Render templates in TypeScript and pass the result as `content`.
 *
 * `check` compares the remote sha256 and `stat` with the declaration in one
 * round trip. `apply` streams the content over stdin, optionally runs
 * `validate` on the staged copy, and writes it in place (or renames it over
 * the file with `atomic`).
 */
export const file = (input: FileInput) => execute(makeFileStep(input));
