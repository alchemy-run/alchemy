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
import { clientExec, runOrFail, succeeded, writeScript } from "./internal.ts";

export interface ManagedBlockInput {
  path: string;
  block: string;
  /** The file's comment syntax, e.g. `#`. The markers are comment lines. */
  commentPrefix: string;
  /** Tells several blocks in one file apart. @default "alchemy" */
  name?: string;
  /** Exact marker lines, for a file that already carries another tool's markers. */
  markers?: { begin: string; end: string };
  /** Create the file when it does not exist. @default false */
  create?: boolean;
  sudo?: boolean;
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

export interface ManagedBlockOutput {
  path: string;
  checksum: string;
}

export const markersFor = (input: ManagedBlockInput) =>
  input.markers ?? {
    begin: `${input.commentPrefix} BEGIN ALCHEMY MANAGED BLOCK ${input.name ?? "alchemy"}`,
    end: `${input.commentPrefix} END ALCHEMY MANAGED BLOCK ${input.name ?? "alchemy"}`,
  };

/**
 * The file with its block replaced in place, or appended when it has none.
 * `undefined` when only one of the markers is present: the other half of the
 * block cannot be located safely.
 */
export const rebuild = (
  current: string,
  block: string,
  markers: { begin: string; end: string },
) => {
  const lines = current === "" ? [] : current.replace(/\n$/, "").split("\n");
  const begin = lines.indexOf(markers.begin);
  const end =
    begin === -1
      ? lines.indexOf(markers.end)
      : lines.indexOf(markers.end, begin);
  if ((begin === -1) !== (end === -1)) return undefined;
  const body = [
    markers.begin,
    ...block.replace(/\n$/, "").split("\n"),
    markers.end,
  ];
  const rebuilt =
    begin === -1
      ? [...lines, ...body]
      : [...lines.slice(0, begin), ...body, ...lines.slice(end + 1)];
  return `${rebuilt.join("\n")}\n`;
};

export const makeManagedBlockStep = (
  input: ManagedBlockInput,
): Step<ManagedBlockOutput> => {
  const step = {
    kind: "managedBlock",
    name: `${input.path}#${input.name ?? "alchemy"}`,
  };
  const options = { sudo: input.sudo };
  const markers = markersFor(input);
  const path = quote(input.path);

  const wanted = Effect.gen(function* () {
    const run = yield* clientExec;
    const read = yield* run(
      `if [ -e ${path} ]; then cat -- ${path}; else exit 66; fi`,
      options,
    );
    if (read.code === 66 && !input.create) {
      return yield* new StepFailed({
        message: `managedBlock[${step.name}]: ${input.path} does not exist`,
        kind: step.kind,
        step: step.name,
      });
    }
    const { stdout } =
      read.code === 66
        ? read
        : yield* succeeded(step, `cat ${input.path}`, read);
    const rebuilt = rebuild(stdout, input.block, markers);
    if (rebuilt === undefined) {
      return yield* new StepFailed({
        message: `managedBlock[${step.name}]: ${input.path} has one marker without the other`,
        kind: step.kind,
        step: step.name,
      });
    }
    return { current: stdout, rebuilt };
  });

  return {
    ...step,
    notify: input.notify,
    policy: input.policy,
    check: Effect.gen(function* () {
      const { current, rebuilt } = yield* wanted;
      const checksum = yield* sha256(rebuilt);
      return current === rebuilt
        ? converged({ path: input.path, checksum })
        : diverged({ checksum: yield* sha256(current) }, { checksum });
    }),
    apply: Effect.gen(function* () {
      const { rebuilt } = yield* wanted;
      yield* runOrFail(step, writeScript(input.path, {}), {
        ...options,
        stdin: rebuilt,
      });
      return applied({ path: input.path, checksum: yield* sha256(rebuilt) });
    }),
  };
};

/**
 * A marker-delimited block in a file, like Ansible's `blockinfile`. Lines
 * outside the markers are left alone. An existing block is replaced where it
 * is; a new one is appended. The file is rewritten in place, keeping its
 * inode, mode and owner.
 */
export const managedBlock = (input: ManagedBlockInput) =>
  execute(makeManagedBlockStep(input));
