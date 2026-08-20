import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CRUD, Plan } from "../Plan.ts";
import { Cli, type PlanDisplayOptions } from "./Cli.ts";
import type { ApplyEvent, ApplyStatus } from "./Event.ts";
import { formatModeNote } from "./ModeTag.ts";
import {
  diffDeclaredProperties,
  fitCreatedPropertyValue,
  fitPropertyChangeValues,
  formatPropertyPath,
  propertyDiffLayout,
  toFormattedPropertyChange,
  type FormattedPropertyChange,
  type PropertyChange,
  type PropertyValue,
} from "./PropertyDiff.ts";

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

export interface PlanRenderOptions extends PlanDisplayOptions {
  // The terminal width only affects inline versus stacked detail rows.
  columns?: number;
}

/** Build the static plan lines used by CI, piped output, and plain terminals. */
export const formatPlanLines = (
  plan: Plan,
  options: PlanRenderOptions = {},
): string[] => {
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
  // Compact remains the default product output; --detailed opts into props.
  const detailed = options.detailed ?? false;
  const lines = [`${bold("Plan:")} ${summary}`];
  // Blank resource blocks improve scanning only in detailed mode; compact
  // deliberately keeps its previous dense output byte-for-byte.
  if (detailed) lines.push("");
  for (const [index, item] of sorted.entries()) {
    if (detailed && index > 0) lines.push("");
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
    if (detailed) {
      // A resource row stays the heading; declared property rows sit below it.
      lines.push(
        ...formatDetailedPropertyLines(
          item,
          options.columns ?? process.stdout.columns ?? 120,
        ),
      );
    }
    for (const binding of item.bindings) {
      if (binding.action === "noop") continue;
      const bindingAction = actionColor[binding.action](binding.action);
      lines.push(
        `${tag(`${item.resource.LogicalId}/${binding.sid}`)} ${bindingAction}`,
      );
    }
  }
  return lines;
};

const formatDetailedPropertyLines = (item: CRUD, columns: number): string[] => {
  // v1 explains create/update/replace inputs; delete and noop stay compact.
  if (item.action === "delete" || item.action === "noop") return [];

  // Create compares against no prior declaration. Updates and replacements
  // compare persisted declared props with the newly desired props.
  const changes = diffDeclaredProperties(
    item.action === "create" ? {} : item.state.props,
    item.props,
  );
  // Actions can originate outside props, so say so instead of inventing rows.
  if (changes.length === 0) {
    return [
      `  ${dim(item.action === "create" ? "no declared properties" : "no declared property changes")}`,
    ];
  }
  // Creates only have desired values, so `+ path value` is clearer than an
  // artificial `(not set) -> value` pair on every line.
  if (item.action === "create") {
    return formatCreatedPropertyLines(changes, columns);
  }
  // Wide terminals render `old -> new`; narrow terminals stack both values.
  const layout = propertyDiffLayout(
    changes.map(toFormattedPropertyChange),
    columns,
  );
  return formatPropertyChanges(changes, layout);
};

const formatCreatedPropertyLines = (
  changes: PropertyChange[],
  columns: number,
): string[] => {
  // Every declared create leaf is a green addition beneath its resource.
  return changes.map(toFormattedPropertyChange).map((row) => {
    const value = fitCreatedPropertyValue(row, columns);
    return `  ${green("+")} ${bold(formatPropertyPath(row.path))}  ${colorPropertyValue(value, row.afterValue, green)}`;
  });
};

const formatPropertyChanges = (
  changes: PropertyChange[],
  layout: ReturnType<typeof propertyDiffLayout>,
): string[] => {
  // Both terminal layouts consume the same semantic PropertyChange rows.
  const rows = changes.map(toFormattedPropertyChange);
  return layout
    ? formatInlinePropertyChanges(rows, layout)
    : rows.flatMap(formatStackedPropertyChange);
};

const formatInlinePropertyChanges = (
  rows: FormattedPropertyChange[],
  layout: NonNullable<ReturnType<typeof propertyDiffLayout>>,
): string[] =>
  // Example: `~ memorySize  512 -> 1024` on a sufficiently wide terminal.
  rows.map((row) => {
    const symbol = colorPropertySymbol(row.kind);
    const path = bold(formatPropertyPath(row.path));
    const values = fitPropertyChangeValues(row, layout);
    const before = colorPropertyValue(
      values.before,
      row.beforeValue,
      row.kind === "remove" || row.kind === "update" ? red : dim,
    );
    const after = colorPropertyValue(
      values.after,
      row.afterValue,
      row.kind === "add" || row.kind === "update" ? green : dim,
    );
    return `  ${symbol} ${path}  ${before}${dim(" → ")}${after}`;
  });

const formatStackedPropertyChange = (
  row: FormattedPropertyChange,
): string[] => {
  // Keep before/after readable when one terminal line is too short.
  const symbol = colorPropertySymbol(row.kind);
  const before = colorPropertyValue(
    row.before,
    row.beforeValue,
    row.kind === "remove" || row.kind === "update" ? red : dim,
  );
  const after = colorPropertyValue(
    row.after,
    row.afterValue,
    row.kind === "add" || row.kind === "update" ? green : dim,
  );
  return [
    `  ${symbol} ${bold(row.path)}`,
    `      ${dim("├─ before")}  ${before}`,
    `      ${dim("└─ after ")}  ${after}`,
  ];
};

const colorPropertySymbol = (kind: FormattedPropertyChange["kind"]): string =>
  // Match resource-plan language: green add, red remove, yellow update.
  kind === "add" ? green("+") : kind === "remove" ? red("-") : yellow("~");

const colorPropertyValue = (
  value: string,
  propertyValue: PropertyValue | undefined,
  fallback: (value: string) => string,
): string => {
  // Semantic placeholders keep distinct colors even when no literal exists:
  // secrets are magenta; deferred/computed values are cyan.
  if (!propertyValue) return yellow(value);
  switch (propertyValue.kind) {
    case "redacted":
      return magenta(value);
    case "known-after-apply":
    case "computed":
      return cyan(value);
    default:
      return fallback(value);
  }
};

/** Line-oriented CLI for CI, agents, pipes, and plain terminal output. */
export const LoggingCli = Layer.succeed(
  Cli,
  Cli.of({
    approvePlan: (plan, options) =>
      Effect.gen(function* () {
        // Non-interactive deploy still previews the plan, but cannot answer the
        // approval prompt and therefore refuses to apply without --yes.
        for (const line of formatPlanLines(plan, options)) {
          yield* Console.log(line);
        }
        yield* Console.log(
          `\n${yellow("Non-interactive terminal detected.")} Pass ${bold("--yes")} to approve, or set ${bold("ALCHEMY_TUI=1")} for the interactive UI.`,
        );
        return false;
      }),
    displayPlan: (plan, options) =>
      Effect.gen(function* () {
        // `alchemy plan` ends after printing this read-only preview.
        for (const line of formatPlanLines(plan, options)) {
          yield* Console.log(line);
        }
      }),
    startApplySession: (plan, options) =>
      Effect.gen(function* () {
        // Approved deploys print the same preview before streaming apply events.
        for (const line of formatPlanLines(plan, options)) {
          yield* Console.log(line);
        }
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
