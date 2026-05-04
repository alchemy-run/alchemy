import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Cli, type PlanStatusSession } from "../Cli/Cli.ts";
import type { ApplyEvent, ApplyStatus } from "../Cli/Event.ts";
import type { Plan } from "../Plan.ts";

const ESC = "\x1b[";
const C = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
  brightGreen: `${ESC}92m`,
  brightYellow: `${ESC}93m`,
  brightBlue: `${ESC}94m`,
  brightMagenta: `${ESC}95m`,
  brightCyan: `${ESC}96m`,
};

const useColor =
  process.env.NO_COLOR == null &&
  process.env.FORCE_COLOR !== "0" &&
  (process.env.FORCE_COLOR != null || process.stdout.isTTY === true);

const paint = (color: string, s: string) =>
  useColor ? `${color}${s}${C.reset}` : s;

const TYPE_PALETTE = [
  C.cyan,
  C.green,
  C.yellow,
  C.magenta,
  C.blue,
  C.brightCyan,
  C.brightGreen,
  C.brightYellow,
  C.brightMagenta,
  C.brightBlue,
];

const stableHash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

const colorForType = (type: string) =>
  TYPE_PALETTE[stableHash(type) % TYPE_PALETTE.length];

const ACTION_STYLE: Record<
  "create" | "update" | "replace" | "delete" | "noop",
  { symbol: string; color: string; label: string }
> = {
  create: { symbol: "+", color: C.green, label: "create" },
  update: { symbol: "~", color: C.yellow, label: "update" },
  replace: { symbol: "!", color: C.magenta, label: "replace" },
  delete: { symbol: "-", color: C.red, label: "delete" },
  noop: { symbol: "·", color: C.gray, label: "noop" },
};

const STATUS_COLOR: Partial<Record<ApplyStatus, string>> = {
  pending: C.gray,
  attaching: C.gray,
  "post-attach": C.gray,
  "pre-creating": C.gray,
  creating: C.green,
  "creating replacement": C.magenta,
  created: C.brightGreen,
  updating: C.yellow,
  updated: C.brightYellow,
  deleting: C.red,
  deleted: C.gray,
  replacing: C.magenta,
  replaced: C.brightMagenta,
  fail: C.red + C.bold,
};

const TERMINAL_STATUSES: ReadonlySet<ApplyStatus> = new Set([
  "created",
  "updated",
  "deleted",
  "replaced",
  "fail",
]);

const print = (line: string) =>
  Effect.sync(() => {
    process.stdout.write(`${line}\n`);
  });

const formatPlanLine = (
  action: keyof typeof ACTION_STYLE,
  type: string,
  id: string,
) => {
  const a = ACTION_STYLE[action];
  return [
    paint(a.color, a.symbol),
    paint(a.color, a.label.padEnd(7)),
    paint(colorForType(type), type.padEnd(28)),
    paint(C.bold, id),
  ].join(" ");
};

const displayPlan = <P extends Plan>(plan: P): Effect.Effect<void> =>
  Effect.gen(function* () {
    const entries = Object.entries(plan.resources ?? {})
      .map(([id, node]) => ({
        id,
        action: node.action,
        type: node.resource.Type,
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    const deletions = Object.entries(plan.deletions ?? {})
      .filter(([, n]) => n != null)
      .map(([id, node]) => ({
        id,
        action: "delete" as const,
        type: node!.resource.Type,
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));

    const all = [...entries, ...deletions];
    if (all.length === 0) {
      yield* print(paint(C.gray, "Plan: no changes"));
      return;
    }

    const counts = all.reduce<Record<string, number>>((acc, e) => {
      acc[e.action] = (acc[e.action] ?? 0) + 1;
      return acc;
    }, {});
    const summary = (["create", "update", "replace", "delete", "noop"] as const)
      .filter((a) => counts[a])
      .map((a) =>
        paint(ACTION_STYLE[a].color, `${counts[a]} ${ACTION_STYLE[a].label}`),
      )
      .join(paint(C.gray, ", "));

    yield* print(paint(C.bold, `Plan (${summary})`));
    for (const e of all) {
      yield* print(`  ${formatPlanLine(e.action as any, e.type, e.id)}`);
    }
  });

const formatStatusLine = (
  event: Extract<ApplyEvent, { kind: "status-change" }>,
) => {
  const statusColor = STATUS_COLOR[event.status] ?? C.gray;
  const statusLabel = paint(statusColor, event.status.padEnd(22));
  const typeLabel = paint(colorForType(event.type), event.type);
  const idLabel = paint(C.bold, event.id);
  const binding = event.bindingId ? paint(C.gray, `[${event.bindingId}] `) : "";
  const message = event.message ? paint(C.dim, ` — ${event.message}`) : "";
  return `  ${statusLabel} ${binding}${typeLabel} ${idLabel}${message}`;
};

const formatAnnotateLine = (event: Extract<ApplyEvent, { kind: "annotate" }>) =>
  `  ${paint(C.gray, "·".padEnd(22))} ${paint(C.bold, event.id)} ${paint(C.dim, event.message)}`;

const startApplySession = <P extends Plan>(_plan: P) =>
  Effect.sync<PlanStatusSession>(() => {
    const counts: Record<string, number> = {};
    return {
      emit: (event) =>
        Effect.sync(() => {
          if (event.kind === "status-change") {
            if (TERMINAL_STATUSES.has(event.status)) {
              counts[event.status] = (counts[event.status] ?? 0) + 1;
            }
            process.stdout.write(`${formatStatusLine(event)}\n`);
          } else {
            process.stdout.write(`${formatAnnotateLine(event)}\n`);
          }
        }),
      done: () =>
        Effect.sync(() => {
          const parts = (
            ["created", "updated", "replaced", "deleted", "fail"] as const
          )
            .filter((s) => counts[s])
            .map((s) => paint(STATUS_COLOR[s] ?? C.gray, `${counts[s]} ${s}`));
          if (parts.length > 0) {
            process.stdout.write(
              `${paint(C.bold, "Apply complete")} ${paint(C.gray, "(")}${parts.join(paint(C.gray, ", "))}${paint(C.gray, ")")}\n`,
            );
          }
        }),
    };
  });

/**
 * CLI implementation tailored for test runners.
 *
 * - `approvePlan` auto-approves so `beforeAll(deploy(Stack))` doesn't hang.
 * - `displayPlan` prints a colored summary with one line per change.
 * - `startApplySession` streams colored status lines for each resource
 *   transition and a final summary count from `done()`.
 *
 * Output goes straight to `process.stdout` rather than through Effect's
 * Logger, so it isn't shadowed by `Stack.ts`'s file logger.
 *
 * No `react`/`ink` dependency — this layer is safe to import from
 * `Test/Bun.ts` / `Test/Vitest.ts` without dragging the TUI deps into
 * every consumer's test setup.
 */
export const TestCli = Layer.succeed(
  Cli,
  Cli.of({
    approvePlan: () => Effect.succeed(true),
    displayPlan,
    startApplySession,
  }),
);
