import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ActionApply, ActionDelete, CRUD, Plan } from "../Plan.ts";
import { Cli } from "./Cli.ts";
import { NonInteractiveTerminal } from "./CliKit/errors.ts";
import { ansiFg, colorsEnabled, theme } from "./CliKit/index.ts";
import { actionStyle } from "./views/statusStyle.ts";
import type { ApplyEvent, ApplyStatus } from "./Event.ts";
import { formatModeNote } from "./ModeTag.ts";
import {
  actionHasPlannedWork,
  resourceHasPlannedWork,
} from "./NamespaceTree.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
// Shared with every other non-ink output path — notably it honors
// FORCE_COLOR, so lines emitted from the piped dev sidecar keep their color.
const useColor = colorsEnabled();
const c = (code: string, s: string) =>
  useColor ? `${ESC}${code}m${s}${RESET}` : s;
const hex = (color: string) => (s: string) =>
  useColor ? `${ansiFg(color)}${s}${RESET}` : s;
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);
const red = hex(theme.color.danger);
const green = hex(theme.color.success);
const yellow = hex(theme.color.warning);
const blue = hex(theme.color.accent);
const cyan = hex(theme.color.info);

// noop stays terminal-dim rather than brand-muted so it recedes in plain logs
const actionColor: Record<CRUD["action"], (s: string) => string> = {
  create: hex(actionStyle.create.color),
  update: hex(actionStyle.update.color),
  replace: hex(actionStyle.replace.color),
  delete: hex(actionStyle.delete.color),
  noop: dim,
};

const statusColor = (status: ApplyStatus): ((s: string) => string) => {
  switch (status) {
    case "created":
    case "updated":
    case "replaced":
      return green;
    case "deleted":
      return dim;
    case "retained":
      return dim;
    case "fail":
      return red;
    case "attaching":
    case "post-attach":
      return cyan;
    default:
      return yellow;
  }
};

const tag = (id: string) => bold(`[${id}]`);

const isTerminal = (status: ApplyStatus): boolean =>
  status === "created" ||
  status === "updated" ||
  status === "deleted" ||
  status === "retained" ||
  status === "replaced" ||
  status === "ran" ||
  status === "fail";

/**
 * Dim `(local)` / `(remote)` / `(local → live)` suffix for a resource row,
 * or `""` when the row's mode matches the run default (the quiet common
 * case). See {@link formatModeNote} for the rule.
 */
const modeSuffix = (options: Parameters<typeof formatModeNote>[0]): string => {
  const note = formatModeNote(options);
  return note ? ` ${dim(`(${note})`)}` : "";
};

/** Exported for unit tests — pure plan-preview rendering. */
export const formatPlanLines = (plan: Plan): string[] => {
  const allItems = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions),
  ] as CRUD[];
  const workItems = allItems.filter(resourceHasPlannedWork);
  const tasks = [
    ...Object.values(plan.actions ?? {}),
    ...Object.values(plan.actionDeletions ?? {}),
  ]
    .filter((task): task is ActionApply | ActionDelete => task !== undefined)
    .filter(actionHasPlannedWork);
  if (allItems.length === 0 && tasks.length === 0) {
    return [`${bold("Plan:")} ${dim("no resources")}`];
  }

  const counts = workItems.reduce(
    (acc, item) => ((acc[item.action] = (acc[item.action] ?? 0) + 1), acc),
    {} as Record<CRUD["action"], number>,
  );
  const bindingChanges = workItems.reduce(
    (count, item) =>
      count +
      item.bindings.filter((binding) => binding.action !== "noop").length,
    0,
  );
  const summaryParts = (["create", "update", "replace", "delete"] as const)
    .filter((a) => counts[a])
    .map((a) => actionColor[a](`${counts[a]} to ${a}`));
  if (bindingChanges > 0) {
    summaryParts.push(cyan(`${bindingChanges} binding changes`));
  }
  if (tasks.length > 0) {
    summaryParts.push(cyan(`${tasks.length} tasks`));
  }
  const summary =
    summaryParts.length === 0
      ? dim("no changes")
      : summaryParts.join(dim(", "));

  const sorted = [...allItems].sort((a, b) =>
    a.resource.LogicalId.localeCompare(b.resource.LogicalId),
  );
  const lines = [`${bold("Plan:")} ${summary}`];
  for (const item of sorted) {
    const action = actionColor[item.action](item.action);
    const mode = modeSuffix({
      mode: item.mode,
      priorMode:
        item.action === "replace" ? item.state.providerMode : undefined,
      defaultMode: plan.defaultMode,
    });
    // Surface FQN migrations: `[Assets] update (renamed from Bucket)` —
    // the update exists to re-brand the moved row's physical resource, and
    // without the note the plan gives no hint why an untouched resource
    // reconciles. (Only apply-side nodes can carry a rename — see
    // `ApplyNodeBase`.)
    const renamed =
      item.action !== "delete" && item.renamedFrom?.length
        ? ` ${dim(`(renamed from ${item.renamedFrom.join(", ")})`)}`
        : "";
    lines.push(`${tag(item.resource.LogicalId)} ${action}${mode}${renamed}`);
    for (const binding of item.bindings) {
      if (binding.action === "noop") continue;
      const bindingAction = actionColor[binding.action](binding.action);
      lines.push(
        `${tag(`${item.resource.LogicalId}/${binding.sid}`)} ${bindingAction}`,
      );
    }
  }
  for (const task of tasks.sort((a, b) =>
    a.def.LogicalId.localeCompare(b.def.LogicalId),
  )) {
    lines.push(
      `${tag(task.def.LogicalId)} ${cyan(task.action === "delete" ? "drop" : "run")} ${dim("[action]")}`,
    );
  }
  return lines;
};

export const LoggingCli = Layer.succeed(
  Cli,
  Cli.of({
    approvePlan: (plan) =>
      Effect.gen(function* () {
        for (const line of formatPlanLines(plan)) yield* Console.log(line);
        return yield* Effect.die(
          new NonInteractiveTerminal({
            operation: "approve deployment plan",
            message:
              "Cannot approve this operation without terminal input. Pass --yes to continue.",
          }),
        );
      }),
    displayPlan: (plan) =>
      Effect.gen(function* () {
        for (const line of formatPlanLines(plan)) yield* Console.log(line);
      }),
    startApplySession: (plan) =>
      Effect.gen(function* () {
        for (const line of formatPlanLines(plan)) yield* Console.log(line);
        yield* Console.log("");

        const terminal = new Map<string, ApplyStatus>();
        const notes = new Map<string, string>();
        return {
          // Write through the Effect Console SERVICE (not the global
          // `console`) so environments that override it — e.g. the
          // alchemy-test runner's per-test buffering console — capture
          // apply progress instead of having it leak to stdout.
          emit: (event: ApplyEvent) =>
            Effect.suspend(() => {
              if (event.kind === "annotate") {
                notes.set(event.id, event.message);
                return terminal.has(event.id)
                  ? Console.log(`${tag(event.id)} ${blue(event.message)}`)
                  : Effect.void;
              }
              const id = event.bindingId
                ? `${event.id}/${event.bindingId}`
                : event.id;
              const status = statusColor(event.status)(event.status);
              const mode = modeSuffix({
                mode: event.providerMode,
                priorMode: event.fromProviderMode,
                defaultMode: plan.defaultMode,
              });
              if (!isTerminal(event.status)) return Effect.void;
              terminal.set(id, event.status);
              const message = event.message ?? notes.get(event.id);
              const msg = message ? ` ${dim("—")} ${message}` : "";
              return Console.log(`${tag(id)} ${status}${mode}${msg}`);
            }),
          done: (outcome) => {
            const failed = [...terminal.values()].filter(
              (status) => status === "fail",
            ).length;
            const succeeded = terminal.size - failed;
            return Console.log(
              `\n${bold(outcome === "success" ? "Done:" : "Failed:")} ${green(`${succeeded} succeeded`)}${failed ? dim(", ") + red(`${failed} failed`) : ""}`,
            );
          },
        };
      }),
  }),
);
