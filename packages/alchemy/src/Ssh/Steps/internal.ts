import * as Effect from "effect/Effect";
import { Client, quote, type ExecOptions, type ExecResult } from "../Client.ts";
import { StepFailed, type StepError } from "../Recipe.ts";

export type StepExec = (
  command: string,
  options?: ExecOptions,
) => Effect.Effect<ExecResult, StepError>;

/** The session's `exec`, from context. */
export const clientExec: Effect.Effect<StepExec, never, Client> = Effect.map(
  Client,
  (client) => client.exec,
);

/** Fail the step unless the command exited 0. */
export const succeeded = (
  step: { kind: string; name: string },
  command: string,
  result: ExecResult,
): Effect.Effect<ExecResult, StepFailed> =>
  result.code === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new StepFailed({
          message: `${step.kind}[${step.name}]: command exited ${result.code}${
            result.stderr.trim() === "" ? "" : `: ${result.stderr.trim()}`
          }`,
          kind: step.kind,
          step: step.name,
          command,
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      );

/** Run a command and fail the step unless it exits 0. */
export const runOrFail = (
  step: { kind: string; name: string },
  command: string,
  options?: ExecOptions,
) =>
  Effect.gen(function* () {
    const run = yield* clientExec;
    return yield* succeeded(step, command, yield* run(command, options));
  });

/** `"0644"`, `"644"` and `0o644` as one number. */
export const parseMode = (mode: string | number) =>
  typeof mode === "number" ? mode : Number.parseInt(mode, 8);

/** As `chmod` takes it and `stat -c %a` prints it. */
export const formatMode = (mode: string | number) =>
  parseMode(mode).toString(8).padStart(3, "0");

export interface Ownership {
  mode?: string | number;
  owner?: string;
  group?: string;
}

export interface Inspected {
  type: "file" | "directory" | "other";
  mode: number;
  owner: string;
  group: string;
  /** For a regular file, when asked for. */
  checksum?: string;
}

/**
 * Print `MISSING`, or the path's type and ownership (and checksum). Any other
 * failure — permission denied, a refused read — exits non-zero, so an
 * unreadable path never reads as missing.
 */
export const inspectScript = (path: string, withChecksum = false) =>
  [
    `p=${quote(path)}`,
    `if ! out=$(LC_ALL=C stat -c '%F|%a %U %G' -- "$p" 2>&1); then`,
    `  case "$out" in *"No such file or directory"*) echo MISSING; exit 0 ;; esac`,
    `  echo "$out" >&2; exit 1`,
    `fi`,
    `echo "$out"`,
    ...(withChecksum
      ? [
          `if [ -f "$p" ]; then sum=$(sha256sum -- "$p") || exit; echo "\${sum%% *}"; fi`,
        ]
      : []),
  ].join("\n");

export const parseInspected = (stdout: string): Inspected | undefined => {
  const [first = "", checksum] = stdout.trim().split("\n");
  if (first === "MISSING") return undefined;
  const [type = "", rest = ""] = first.split("|");
  const [mode = "0", owner = "", group = ""] = rest.split(" ");
  return {
    type:
      type === "regular file" || type === "regular empty file"
        ? "file"
        : type === "directory"
          ? "directory"
          : "other",
    mode: parseMode(mode),
    owner,
    group,
    ...(checksum === undefined ? {} : { checksum }),
  };
};

/** Inspect a path, failing the step when it cannot be read. */
export const inspect = (
  step: { kind: string; name: string },
  path: string,
  options: { sudo?: boolean; checksum?: boolean } = {},
) =>
  Effect.map(
    runOrFail(step, inspectScript(path, options.checksum), {
      sudo: options.sudo,
    }),
    (result) => parseInspected(result.stdout),
  );

/** The declared ownership that differs from what is on disk. */
export const ownershipDiff = (wanted: Ownership, actual: Inspected) => {
  const current: Record<string, unknown> = {};
  const desired: Record<string, unknown> = {};
  if (wanted.mode !== undefined && parseMode(wanted.mode) !== actual.mode) {
    current.mode = formatMode(actual.mode);
    desired.mode = formatMode(wanted.mode);
  }
  if (wanted.owner !== undefined && wanted.owner !== actual.owner) {
    current.owner = actual.owner;
    desired.owner = wanted.owner;
  }
  if (wanted.group !== undefined && wanted.group !== actual.group) {
    current.group = actual.group;
    desired.group = wanted.group;
  }
  return { current, desired, differs: Object.keys(desired).length > 0 };
};

export const declaredOwnership = (wanted: Ownership) => ({
  ...(wanted.mode === undefined ? {} : { mode: formatMode(wanted.mode) }),
  ...(wanted.owner === undefined ? {} : { owner: wanted.owner }),
  ...(wanted.group === undefined ? {} : { group: wanted.group }),
});

export const ownershipCommands = (path: string, wanted: Ownership) => [
  ...(wanted.mode === undefined
    ? []
    : [`chmod ${formatMode(wanted.mode)} ${quote(path)}`]),
  ...(wanted.owner === undefined && wanted.group === undefined
    ? []
    : [
        `chown ${wanted.owner ?? ""}${wanted.group === undefined ? "" : `:${wanted.group}`} ${quote(path)}`,
      ]),
];

export const parentOf = (path: string) =>
  path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";

export interface WriteOptions extends Ownership {
  /**
   * Replace the file by renaming a temp file over it (a new inode). Off, the
   * file is rewritten in place, which a file bind-mounted into a container
   * needs.
   * @default false
   */
  atomic?: boolean;
  /**
   * Run on the staged copy before it lands, `%s` replaced by its path. A
   * non-zero exit leaves the destination untouched.
   */
  validate?: string;
}

/**
 * Write stdin to `path`: stage next to it, validate, land, then chmod/chown.
 * An atomic replace first copies the existing file's mode and owner onto the
 * staged copy (a new file gets `0666 & ~umask`), since `mktemp` creates it
 * 0600.
 */
export const writeScript = (path: string, options: WriteOptions) => {
  const dest = quote(path);
  return [
    "set -e",
    `mkdir -p ${quote(parentOf(path))}`,
    `t=$(mktemp ${quote(`${parentOf(path)}/.alchemy.XXXXXX`)})`,
    `trap 'rm -f "$t"' EXIT`,
    'cat > "$t"',
    ...(options.validate === undefined
      ? []
      : [options.validate.replaceAll("%s", '"$t"')]),
    ...(options.atomic
      ? [
          `if [ -e ${dest} ]; then`,
          `  chmod --reference=${dest} "$t"`,
          `  chown --reference=${dest} "$t" 2>/dev/null || true`,
          "else",
          `  chmod "$(printf '%o' $((0666 & ~$(umask))))" "$t"`,
          "fi",
          `mv -f "$t" ${dest}`,
        ]
      : [
          // A declared mode is applied below; close the umask so a new file
          // is never readable by others before that.
          ...(options.mode === undefined ? [] : ["umask 077"]),
          `cat "$t" > ${dest}`,
        ]),
    ...ownershipCommands(path, options),
  ].join("\n");
};
