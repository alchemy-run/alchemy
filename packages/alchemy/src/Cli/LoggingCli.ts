import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CRUD, Plan } from "../Plan.ts";
import { Cli } from "./Cli.ts";
import type { ApplyEvent, ApplyStatus } from "./Event.ts";

const actionIcon: Record<CRUD["action"], string> = {
  create: "+",
  update: "~",
  replace: "!",
  delete: "-",
  noop: "•",
};

const isTerminal = (status: ApplyStatus): boolean =>
  status === "created" ||
  status === "updated" ||
  status === "deleted" ||
  status === "replaced" ||
  status === "fail";

const formatPlanLines = (plan: Plan): string[] => {
  const items = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions),
  ] as CRUD[];
  if (items.length === 0) return ["Plan: no changes"];

  const counts = items.reduce(
    (acc, item) => ((acc[item.action] = (acc[item.action] ?? 0) + 1), acc),
    {} as Record<CRUD["action"], number>,
  );
  const summary = (
    ["create", "update", "replace", "delete", "noop"] as const
  )
    .filter((a) => counts[a])
    .map((a) => `${counts[a]} to ${a}`)
    .join(", ");

  const sorted = [...items].sort((a, b) =>
    a.resource.LogicalId.localeCompare(b.resource.LogicalId),
  );
  const lines = [`Plan: ${summary}`];
  for (const item of sorted) {
    lines.push(
      `  ${actionIcon[item.action]} ${item.resource.LogicalId} (${item.resource.Type})`,
    );
    for (const binding of item.bindings) {
      lines.push(
        `      ${actionIcon[binding.action]} ${binding.sid}`,
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
          "\nNon-interactive terminal detected — pass --yes to approve, or unset ALCHEMY_PLAIN to use the interactive UI.",
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
          emit: (event: ApplyEvent) =>
            Effect.sync(() => {
              if (event.kind === "annotate") {
                console.log(`  ${event.id}: ${event.message}`);
                return;
              }
              const suffix = event.message ? ` — ${event.message}` : "";
              console.log(
                `  ${event.status} ${event.id} (${event.type})${suffix}`,
              );
              if (isTerminal(event.status)) {
                if (event.status === "fail") counts.fail++;
                else counts.ok++;
              }
            }),
          done: () =>
            Console.log(
              `\nDone: ${counts.ok} succeeded${counts.fail ? `, ${counts.fail} failed` : ""}`,
            ),
        };
      }),
  }),
);
