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
import { clientExec, runOrFail, succeeded } from "./internal.ts";

export interface DnfInput {
  /** Exact package names; versions, groups and paths are not supported. */
  packages: string | ReadonlyArray<string>;
  /** @default "present" */
  state?: "present" | "absent" | "latest";
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

export interface DnfOutput {
  /** Installed `version-release` per package; absent packages are omitted. */
  installed: Record<string, string>;
}

/** `rpm -q --qf '%{NAME}\t%{VERSION}-%{RELEASE}\n'` into installed versions. */
export const parseRpmQuery = (stdout: string) => {
  const installed: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const [pkg, version] = line.split("\t");
    if (pkg && version) installed[pkg] = version;
  }
  return installed;
};

/** Package names in `dnf check-update` output, without their `.arch`. */
export const parseCheckUpdate = (stdout: string) =>
  stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length === 3)
    .map(([nameArch = ""]) => nameArch.slice(0, nameArch.lastIndexOf(".")));

export const makeDnfStep = (input: DnfInput): Step<DnfOutput> => {
  const packages =
    typeof input.packages === "string" ? [input.packages] : [...input.packages];
  const step = { kind: "dnf", name: packages.join(" ") };
  const state = input.state ?? "present";
  const names = packages.map(quote).join(" ");

  const query = Effect.map(
    runOrFail(
      step,
      `rpm -q --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\n' ${names} 2>/dev/null; true`,
    ),
    (result) => parseRpmQuery(result.stdout),
  );

  return {
    ...step,
    notify: input.notify,
    policy: input.policy,
    check: Effect.gen(function* () {
      const installed = yield* query;
      if (state === "absent") {
        const present = packages.filter((pkg) => pkg in installed);
        return present.length === 0
          ? converged({ installed })
          : diverged({ present }, { absent: present });
      }
      const missing = packages.filter((pkg) => !(pkg in installed));
      if (missing.length > 0) {
        return diverged({ missing }, { installed: packages });
      }
      if (state === "latest") {
        const run = yield* clientExec;
        const command = `dnf -q check-update ${names}`;
        const result = yield* run(command);
        // Exit 100 means updates are available; anything else non-zero failed.
        if (result.code === 100) {
          return diverged(
            { outdated: parseCheckUpdate(result.stdout) },
            { latest: packages },
          );
        }
        yield* succeeded(step, command, result);
      }
      return converged({ installed });
    }),
    apply: Effect.gen(function* () {
      yield* runOrFail(
        step,
        state === "absent"
          ? `dnf -y -q remove ${names}`
          : state === "latest"
            ? `dnf -y -q install ${names} && dnf -y -q upgrade ${names}`
            : `dnf -y -q install ${names}`,
        { sudo: true },
      );
      return applied({ installed: yield* query });
    }),
  };
};

/** Fedora/RHEL packages. */
export const dnf = (input: DnfInput) => execute(makeDnfStep(input));
