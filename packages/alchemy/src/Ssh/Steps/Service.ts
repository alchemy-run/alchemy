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

export interface ServiceInput {
  /** The systemd unit, e.g. `nginx` or `nginx.service`. */
  name: string;
  enabled?: boolean;
  /** `restarted` and `reloaded` always act; use them from a handler. */
  state?: "started" | "stopped" | "restarted" | "reloaded";
  /** Run `systemctl daemon-reload` when a unit file changed on disk. */
  daemonReload?: boolean;
  notify?: ReadonlyArray<string>;
  policy?: StepPolicy;
}

export interface ServiceOutput {
  activeState: string;
  unitFileState: string;
}

// Only these can be flipped with `systemctl enable`/`disable`; any other
// state (`static`, `indirect`, `generated`, …) is left as it is.
const TOGGLEABLE = new Set(["enabled", "disabled"]);

const isActive = (state: string) =>
  state === "active" || state === "activating";

/** `systemctl show -p …` output (`Key=value` lines) as a record. */
export const parseSystemctlShow = (stdout: string): Record<string, string> =>
  Object.fromEntries(
    stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );

export const makeServiceStep = (input: ServiceInput): Step<ServiceOutput> => {
  const step = { kind: "service", name: input.name };
  const root = { sudo: true };
  const unit = quote(input.name);

  const show = Effect.map(
    runOrFail(
      step,
      `systemctl show -p LoadState -p ActiveState -p UnitFileState -p NeedDaemonReload ${unit}`,
    ),
    (result) => {
      const props = parseSystemctlShow(result.stdout);
      return {
        loadState: props.LoadState ?? "",
        activeState: props.ActiveState ?? "",
        unitFileState: props.UnitFileState ?? "",
        needDaemonReload: props.NeedDaemonReload === "yes",
      };
    },
  );

  const plan = (current: Effect.Success<typeof show>) => ({
    daemonReload: input.daemonReload === true && current.needDaemonReload,
    enable:
      input.enabled !== undefined &&
      TOGGLEABLE.has(current.unitFileState) &&
      (current.unitFileState === "enabled") !== input.enabled,
    start: input.state === "started" && !isActive(current.activeState),
    stop: input.state === "stopped" && isActive(current.activeState),
    restart: input.state === "restarted",
    reload: input.state === "reloaded",
  });

  return {
    ...step,
    notify: input.notify,
    policy: input.policy,
    verify: input.state !== "restarted" && input.state !== "reloaded",
    check: Effect.gen(function* () {
      const current = yield* show;
      const todo = plan(current);
      if (!Object.values(todo).some(Boolean)) {
        return converged({
          activeState: current.activeState,
          unitFileState: current.unitFileState,
        });
      }
      return diverged(
        {
          loadState: current.loadState,
          activeState: current.activeState,
          unitFileState: current.unitFileState,
          ...(todo.daemonReload ? { needDaemonReload: true } : {}),
        },
        {
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.state === undefined ? {} : { state: input.state }),
        },
      );
    }),
    apply: Effect.gen(function* () {
      const todo = plan(yield* show);
      const commands = [
        ...(todo.daemonReload ? ["systemctl daemon-reload"] : []),
        ...(todo.enable
          ? [`systemctl ${input.enabled ? "enable" : "disable"} ${unit}`]
          : []),
        ...(todo.start ? [`systemctl start ${unit}`] : []),
        ...(todo.stop ? [`systemctl stop ${unit}`] : []),
        ...(todo.restart ? [`systemctl restart ${unit}`] : []),
        ...(todo.reload ? [`systemctl reload ${unit}`] : []),
      ];
      for (const command of commands) {
        yield* runOrFail(step, command, root);
      }
      const after = yield* show;
      return applied({
        activeState: after.activeState,
        unitFileState: after.unitFileState,
      });
    }),
  };
};

/** A systemd unit's enablement and run state. */
export const service = (input: ServiceInput) => execute(makeServiceStep(input));
