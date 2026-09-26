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
import { runOrFail } from "./internal.ts";

export type UfwPolicy = "allow" | "deny" | "reject";

export interface UfwInput {
  defaults?: { incoming?: UfwPolicy; outgoing?: UfwPolicy };
  /**
   * Rules in `ufw` syntax, e.g. `"allow 22/tcp"`, `"limit ssh"` or
   * `"allow from 10.0.0.0/8 to any port 5432 proto tcp"`. Rules that are not
   * declared are left alone.
   */
  rules?: ReadonlyArray<string>;
  /** Enabling with `incoming: "deny"` needs a rule that allows SSH. @default true */
  enabled?: boolean;
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

export interface UfwStatus {
  enabled: boolean;
  incoming: UfwPolicy | undefined;
  outgoing: UfwPolicy | undefined;
  /** The declared rules `ufw` does not have yet. */
  missing: string[];
}

const POLICIES: Record<string, UfwPolicy> = {
  ACCEPT: "allow",
  DROP: "deny",
  REJECT: "reject",
};

const ruleArgs = (rule: string) =>
  rule.trim().split(/\s+/).map(quote).join(" ");

/**
 * Print the defaults, enablement and whether `ufw` already has each rule,
 * from its config files and `--dry-run`, so the firewall need not be active.
 */
export const ufwStatusScript = (rules: ReadonlyArray<string>) =>
  [
    "command -v ufw >/dev/null 2>&1 || { echo MISSING; exit 0; }",
    ". /etc/default/ufw",
    'echo "incoming=$DEFAULT_INPUT_POLICY"',
    'echo "outgoing=$DEFAULT_OUTPUT_POLICY"',
    ". /etc/ufw/ufw.conf",
    'echo "enabled=$ENABLED"',
    ...rules.map((rule, index) =>
      [
        `out=$(ufw --dry-run ${ruleArgs(rule)} 2>&1) || { echo "$out" >&2; exit 1; }`,
        `case "$out" in *"Rules updated"*) echo "rule${index}=missing" ;; *) echo "rule${index}=present" ;; esac`,
      ].join("\n"),
    ),
  ].join("\n");

export const parseUfwStatus = (
  stdout: string,
  rules: ReadonlyArray<string>,
): UfwStatus | undefined => {
  if (stdout.trim() === "MISSING") return undefined;
  const values = Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return {
    enabled: values.enabled === "yes",
    incoming: POLICIES[values.incoming?.replaceAll('"', "") ?? ""],
    outgoing: POLICIES[values.outgoing?.replaceAll('"', "") ?? ""],
    missing: rules.filter((_, index) => values[`rule${index}`] === "missing"),
  };
};

export const makeUfwStep = (input: UfwInput): Step<UfwStatus> => {
  const step = { kind: "ufw", name: "firewall" };
  const root = { sudo: true };
  const rules = input.rules ?? [];
  const enabled = input.enabled !== false;

  const status = Effect.map(
    runOrFail(step, ufwStatusScript(rules), root),
    (result) => parseUfwStatus(result.stdout, rules),
  );

  const plan = (current: UfwStatus) => [
    ...(input.defaults?.incoming !== undefined &&
    current.incoming !== input.defaults.incoming
      ? [`ufw default ${input.defaults.incoming} incoming`]
      : []),
    ...(input.defaults?.outgoing !== undefined &&
    current.outgoing !== input.defaults.outgoing
      ? [`ufw default ${input.defaults.outgoing} outgoing`]
      : []),
    ...current.missing.map((rule) => `ufw ${ruleArgs(rule)}`),
    ...(enabled && !current.enabled ? ["ufw --force enable"] : []),
    ...(!enabled && current.enabled ? ["ufw --force disable"] : []),
  ];

  return {
    ...step,
    notify: input.notify,
    policy: input.policy,
    check: Effect.gen(function* () {
      const current = yield* status;
      if (current === undefined) {
        return diverged({ installed: false }, { installed: true });
      }
      if (plan(current).length === 0) return converged(current);
      return diverged(
        {
          enabled: current.enabled,
          incoming: current.incoming,
          outgoing: current.outgoing,
          missing: current.missing,
        },
        { enabled, ...input.defaults, rules },
      );
    }),
    apply: Effect.gen(function* () {
      const current = yield* status;
      if (current === undefined) {
        return yield* new StepFailed({
          message: "ufw[firewall]: ufw is not installed",
          kind: step.kind,
          step: step.name,
        });
      }
      for (const command of plan(current)) {
        yield* runOrFail(step, command, root);
      }
      const after = yield* status;
      return applied(after ?? current);
    }),
  };
};

/**
 * The `ufw` firewall: default policies, rules and enablement in one
 * declaration. Each rule is checked with `ufw --dry-run`, so `ufw`'s own
 * matching decides whether it already exists (`limit ssh` matches
 * `limit 22/tcp`). Install `ufw` first, e.g. with `package`.
 */
export const ufw = (input: UfwInput) => execute(makeUfwStep(input));
