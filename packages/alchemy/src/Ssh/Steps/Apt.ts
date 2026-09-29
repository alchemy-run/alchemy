import * as Duration from "effect/Duration";
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

export interface AptInput {
  /** Package names, optionally `name=version` or `name:arch`. */
  packages: string | ReadonlyArray<string>;
  /** @default "present" */
  state?: "present" | "absent" | "latest";
  /** Refresh the package index before installing, when it is stale. */
  update?: boolean;
  /** How old the index may be before `update` refreshes it. @default "1 hour" */
  cacheValidTime?: Duration.Input;
  /** Seconds to wait for the dpkg lock. @default 60 */
  lockTimeout?: number;
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

export interface AptOutput {
  /** Installed version per package; absent packages are omitted. */
  installed: Record<string, string>;
}

const LISTS_DIR = "/var/lib/apt/lists";
const SOURCES = "/etc/apt/sources.list /etc/apt/sources.list.d";

/** `name[:arch][=version]` into the name dpkg reports and the pinned version. */
export const parseAptSpec = (spec: string) => {
  const [qualified = spec, version] = spec.split("=", 2);
  return { name: qualified.split(":")[0] ?? qualified, version };
};

/**
 * `dpkg-query -W -f='${Package}\t${Status}\t${Version}\n'` into installed
 * versions. The status's last word is the install state, so a held package
 * (`hold ok installed`) counts as installed.
 */
export const parseDpkgQuery = (stdout: string) => {
  const installed: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const [pkg, status, version] = line.split("\t");
    if (pkg && version && status?.split(" ").at(-1) === "installed") {
      installed[pkg] = version;
    }
  }
  return installed;
};

/** `apt-cache policy` into `{ pkg: { installed, candidate } }`. */
export const parseAptCachePolicy = (stdout: string) => {
  const policies: Record<string, { installed: string; candidate: string }> = {};
  let current: { installed: string; candidate: string } | undefined;
  for (const line of stdout.split("\n")) {
    if (line.length > 0 && !line.startsWith(" ") && line.endsWith(":")) {
      current = { installed: "", candidate: "" };
      policies[line.slice(0, -1)] = current;
    } else if (current !== undefined) {
      const [key, value = ""] = line.trim().split(": ");
      if (key === "Installed") current.installed = value;
      if (key === "Candidate") current.candidate = value;
    }
  }
  return policies;
};

export const makeAptStep = (input: AptInput): Step<AptOutput> => {
  const specs =
    typeof input.packages === "string" ? [input.packages] : [...input.packages];
  const parsed = specs.map(parseAptSpec);
  const step = { kind: "apt", name: specs.join(" ") };
  const state = input.state ?? "present";
  const root = { sudo: true, env: { DEBIAN_FRONTEND: "noninteractive" } };
  // Keep locally modified conffiles without prompting, and wait for the lock
  // held by unattended-upgrades instead of failing.
  const aptGet = `apt-get -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o DPkg::Lock::Timeout=${input.lockTimeout ?? 60}`;
  const names = parsed.map((spec) => quote(spec.name)).join(" ");

  const query = Effect.map(
    runOrFail(
      step,
      `dpkg-query -W -f='\${Package}\\t\${Status}\\t\${Version}\\n' ${names} 2>/dev/null; true`,
    ),
    (result) => parseDpkgQuery(result.stdout),
  );

  const indexStale = Effect.gen(function* () {
    if (input.update !== true) return false;
    const { stdout } = yield* runOrFail(
      step,
      `if [ -n "$(find ${SOURCES} -newer ${LISTS_DIR} 2>/dev/null)" ]; then echo stale; else echo $(( $(date +%s) - $(stat -c %Y ${LISTS_DIR} 2>/dev/null || echo 0) )); fi`,
    );
    const age = Number.parseInt(stdout, 10);
    return (
      Number.isNaN(age) ||
      age > Duration.toSeconds(input.cacheValidTime ?? "1 hour")
    );
  });

  return {
    ...step,
    notify: input.notify,
    policy: input.policy,
    check: Effect.gen(function* () {
      const installed = yield* query;
      if (state === "absent") {
        const present = parsed.filter((spec) => spec.name in installed);
        return present.length === 0
          ? converged({ installed })
          : diverged(
              { present: present.map((spec) => spec.name) },
              { absent: present.map((spec) => spec.name) },
            );
      }
      const missing = parsed.filter(
        (spec) =>
          !(spec.name in installed) ||
          (spec.version !== undefined && installed[spec.name] !== spec.version),
      );
      if (missing.length > 0) {
        return diverged(
          {
            installed: Object.fromEntries(
              missing.map((spec) => [spec.name, installed[spec.name] ?? null]),
            ),
          },
          { installed: missing.map((spec) => specs[parsed.indexOf(spec)]) },
        );
      }
      if (state === "latest") {
        const { stdout } = yield* runOrFail(step, `apt-cache policy ${names}`);
        const policy = parseAptCachePolicy(stdout);
        const outdated = parsed.filter(
          ({ name }) =>
            policy[name] !== undefined &&
            policy[name].installed !== policy[name].candidate,
        );
        if (outdated.length > 0) {
          return diverged(
            {
              installed: Object.fromEntries(
                outdated.map(({ name }) => [name, policy[name]?.installed]),
              ),
            },
            {
              installed: Object.fromEntries(
                outdated.map(({ name }) => [name, policy[name]?.candidate]),
              ),
            },
          );
        }
      }
      return converged({ installed });
    }),
    apply: Effect.gen(function* () {
      if (state !== "absent" && (yield* indexStale)) {
        yield* runOrFail(step, `${aptGet} update`, root);
      }
      yield* runOrFail(
        step,
        state === "absent"
          ? `${aptGet} remove ${names}`
          : `${aptGet} install ${specs.map(quote).join(" ")}`,
        root,
      );
      return applied({ installed: yield* query });
    }),
  };
};

/**
 * Debian/Ubuntu packages. `check` asks `dpkg-query`
 * (and `apt-cache policy` for `latest`), never `apt-get`, so a converged host
 * never refreshes its index. For packages that should work on any distro,
 * use `package`.
 */
export const apt = (input: AptInput) => execute(makeAptStep(input));
