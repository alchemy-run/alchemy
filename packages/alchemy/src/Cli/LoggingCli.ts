import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RateLine } from "../Cost.ts";
import type { CRUD, Plan } from "../Plan.ts";
import { Cli } from "./Cli.ts";
import type { ApplyEvent, ApplyStatus } from "./Event.ts";
import { formatModeNote } from "./ModeTag.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const useColor = process.stdout.hasColors?.() ?? !!process.stdout.isTTY;
const c = (code: string, s: string) =>
  useColor ? `${ESC}${code}m${s}${RESET}` : s;
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);
const red = (s: string) => c("31", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);
const blue = (s: string) => c("34", s);
const magenta = (s: string) => c("35", s);
const cyan = (s: string) => c("36", s);

const actionColor: Record<CRUD["action"], (s: string) => string> = {
  create: green,
  update: yellow,
  replace: magenta,
  delete: red,
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
  const items = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions),
  ] as CRUD[];
  if (items.length === 0) return [bold("Plan:") + " no changes"];

  const counts = items.reduce(
    (acc, item) => ((acc[item.action] = (acc[item.action] ?? 0) + 1), acc),
    {} as Record<CRUD["action"], number>,
  );
  const summary = (["create", "update", "replace", "delete", "noop"] as const)
    .filter((a) => counts[a])
    .map((a) => actionColor[a](`${counts[a]} to ${a}`))
    .join(dim(", "));

  const sorted = [...items].sort((a, b) =>
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
    lines.push(`${tag(item.resource.LogicalId)} ${action}${mode}`);
    for (const binding of item.bindings) {
      if (binding.action === "noop") continue;
      const bindingAction = actionColor[binding.action](binding.action);
      lines.push(
        `${tag(`${item.resource.LogicalId}/${binding.sid}`)} ${bindingAction}`,
      );
    }
  }
  lines.push(...formatCostSummaryLines(sorted));
  return lines;
};

/**
 * Strips floating-point noise (e.g. `0.0000025 * 3600` → `0.009000000000000001`)
 * from a computed rate before display. Fixed at 8 decimal places — the
 * smallest published rate priced today is $0.00000007 — then trims
 * trailing zeros; plain `Number(...).toString()` was rejected because it
 * switches to exponential notation below 1e-6 (`"7e-8"`, unreadable as a
 * price). Revisit the fixed precision if a future rate needs more decimals.
 */
export const formatRateUsd = (usd: number): string => {
  const fixed = usd.toFixed(8);
  return fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
};

/**
 * `alchemy plan`'s cost summary: sums each touched resource's deterministic
 * floor (mostly $0 — see `../Cost.ts`) plus the $5/mo Workers Paid plan base
 * fee exactly once if anything touched requires it, then lists every
 * usage-based rate for reference — never fabricated into a total, since
 * actual usage is unknowable at plan time. Silent (returns no lines) when
 * nothing touched in this plan has a `pricing` model attached.
 */
export const WORKERS_PAID_PLAN_USD = 5.0;

/** @internal exported only so its aggregation logic (dedup-by-type, once-only base fee) can be unit tested without constructing a full `Plan` tree. */
export const formatCostSummaryLines = (items: CRUD[]): string[] => {
  let floorTotal = 0;
  let requiresPaidPlan = false;
  const ratesByResourceType = new Map<string, RateLine[]>();

  for (const item of items) {
    // Only creates/updates/replaces carry `props` (deletes are going away —
    // nothing to price; noops carry no new props to price against either).
    if (item.action === "delete" || item.action === "noop") continue;
    const pricing = item.provider.pricing;
    if (!pricing) continue;
    floorTotal += pricing.floorMonthlyUsd(item.props);
    requiresPaidPlan ||= pricing.requiresPaidPlan;
    if (!ratesByResourceType.has(item.resource.Type)) {
      ratesByResourceType.set(item.resource.Type, pricing.rates(item.props));
    }
  }

  if (ratesByResourceType.size === 0) return [];

  const total = floorTotal + (requiresPaidPlan ? WORKERS_PAID_PLAN_USD : 0);
  const lines = [
    "",
    `${bold("Estimated minimum monthly cost:")} ${green(`$${total.toFixed(2)}`)}`,
  ];
  if (requiresPaidPlan) {
    lines.push(
      dim(
        `  includes the $${WORKERS_PAID_PLAN_USD.toFixed(2)}/mo Workers Paid plan base fee`,
      ),
    );
  }
  lines.push(
    dim(
      "  usage-based rates below are not included above — actual usage is unknown at plan time",
    ),
  );
  for (const [resourceType, rates] of ratesByResourceType) {
    lines.push(dim(`  ${resourceType}`));
    for (const rate of rates) {
      const free = rate.freeIncluded ? dim(` (${rate.freeIncluded})`) : "";
      lines.push(
        dim(`    ${rate.label}: `) +
          cyan(`$${formatRateUsd(rate.perUnit)}`) +
          dim(` / ${rate.unit}`) +
          free,
      );
    }
  }
  return lines;
};

export const LoggingCli = Layer.succeed(
  Cli,
  Cli.of({
    approvePlan: (plan) =>
      Effect.gen(function* () {
        for (const line of formatPlanLines(plan)) yield* Console.log(line);
        yield* Console.log(
          `\n${yellow("Non-interactive terminal detected.")} Pass ${bold("--yes")} to approve, or set ${bold("ALCHEMY_TUI=1")} for the interactive UI.`,
        );
        return false;
      }),
    displayPlan: (plan) =>
      Effect.gen(function* () {
        for (const line of formatPlanLines(plan)) yield* Console.log(line);
      }),
    startApplySession: (plan) =>
      Effect.gen(function* () {
        for (const line of formatPlanLines(plan)) yield* Console.log(line);
        yield* Console.log("");

        const counts = { ok: 0, fail: 0 };
        return {
          // Write through the Effect Console SERVICE (not the global
          // `console`) so environments that override it — e.g. the
          // alchemy-test runner's per-test buffering console — capture
          // apply progress instead of having it leak to stdout.
          emit: (event: ApplyEvent) =>
            Effect.suspend(() => {
              if (event.kind === "annotate") {
                return Console.log(`${tag(event.id)} ${blue(event.message)}`);
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
              const msg = event.message ? ` ${dim("—")} ${event.message}` : "";
              if (isTerminal(event.status)) {
                if (event.status === "fail") counts.fail++;
                else counts.ok++;
              }
              return Console.log(`${tag(id)} ${status}${mode}${msg}`);
            }),
          done: () =>
            Console.log(
              `\n${bold("Done:")} ${green(`${counts.ok} succeeded`)}${counts.fail ? dim(", ") + red(`${counts.fail} failed`) : ""}`,
            ),
        };
      }),
  }),
);
