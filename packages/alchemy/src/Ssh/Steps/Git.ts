import * as Effect from "effect/Effect";
import { quote } from "../Client.ts";
import {
  applied,
  converged,
  diverged,
  execute,
  type Step,
  type StepPolicy,
} from "../Recipe.ts";
import { runOrFail } from "./internal.ts";

export interface GitInput {
  repo: string;
  dest: string;
  /**
   * A tag, commit or branch. A branch is resolved against `origin/`, but
   * `check` does not fetch, so a branch that moved upstream reads as converged
   * until a later apply fetches.
   */
  version: string;
  sudo?: boolean;
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

export interface GitOutput {
  before: string | undefined;
  after: string;
}

export const makeGitStep = (input: GitInput): Step<GitOutput> => {
  const step = { kind: "git", name: input.dest };
  const options = { sudo: input.sudo };
  const dest = quote(input.dest);
  // A remote-tracking branch first, so a branch follows `origin` instead of
  // the stale local branch of the same name.
  const target = `$(git -C ${dest} rev-parse --verify -q ${quote(`origin/${input.version}^{commit}`)} || git -C ${dest} rev-parse --verify -q ${quote(`${input.version}^{commit}`)})`;

  const state = Effect.gen(function* () {
    const { stdout } = yield* runOrFail(
      step,
      `if [ -d ${dest}/.git ]; then git -C ${dest} rev-parse HEAD; echo "${target}"; git -C ${dest} remote get-url origin; else echo MISSING; fi`,
      options,
    );
    const [head, resolved = "", origin = ""] = stdout.trim().split("\n");
    return head === "MISSING" || head === undefined
      ? undefined
      : { head, target: resolved || undefined, origin };
  });

  return {
    ...step,
    notify: input.notify,
    policy: input.policy,
    check: Effect.gen(function* () {
      const current = yield* state;
      if (current === undefined) {
        return diverged(
          { state: "absent" },
          { repo: input.repo, version: input.version },
        );
      }
      if (current.origin !== input.repo) {
        return diverged({ repo: current.origin }, { repo: input.repo });
      }
      return current.target !== undefined && current.head === current.target
        ? converged({ before: current.head, after: current.head })
        : diverged({ head: current.head }, { version: input.version });
    }),
    apply: Effect.gen(function* () {
      const before = yield* state;
      yield* runOrFail(
        step,
        [
          "set -e",
          before === undefined
            ? `git clone ${quote(input.repo)} ${dest}`
            : `git -C ${dest} remote set-url origin ${quote(input.repo)}`,
          `git -C ${dest} fetch --tags --force origin`,
          // Detached at the resolved commit. A dirty worktree makes this fail
          // rather than lose local changes.
          `git -C ${dest} checkout --detach "${target}"`,
        ].join("\n"),
        options,
      );
      const after = yield* state;
      return applied({ before: before?.head, after: after?.head ?? "" });
    }),
  };
};

/** A checkout of `repo` at `version` under `dest`. */
export const git = (input: GitInput) => execute(makeGitStep(input));
