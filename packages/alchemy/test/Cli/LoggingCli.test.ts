import { LoggingCli, formatPlanLines } from "@/Cli/LoggingCli.ts";
import { Cli } from "@/Report.ts";
import { describe, expect, it, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import {
  createNode,
  deleteNode,
  planWith,
  replaceNode,
  updateNode,
} from "./PlanTestNodes.ts";

describe("formatPlanLines", () => {
  test("keeps compact output unchanged by default", () => {
    expect(
      formatPlanLines(
        planWith([
          updateNode({ value: "old" }, { value: "new" }, "First"),
          replaceNode({ engine: "v1" }, { engine: "v2" }, "Second"),
        ]),
      ),
    ).toEqual([
      "Plan: 1 to update, 1 to replace",
      "[First] update",
      "[Second] replace",
    ]);
  });

  test("renders detailed creates and updates as YAML", () => {
    const output = formatPlanLines(
      planWith([
        createNode({ region: "iad", ports: [80, 443] }, "Api"),
        updateNode({ retries: 2 }, { retries: 3 }, "Worker"),
      ]),
      { detailed: true },
    ).join("\n");
    expect(output).toContain("  properties:\n    ports:\n      - 80");
    expect(output).toContain("  properties:\n  -   retries: 2");
    expect(output).toContain("  +   retries: 3");
  });

  test("keeps deletes compact and reports non-property replacements", () => {
    const output = formatPlanLines(
      planWith(
        [replaceNode({ name: "same" }, { name: "same" })],
        [deleteNode({ secret: "old" }, "OldWorker")],
      ),
      { detailed: true },
    ).join("\n");
    expect(output).toContain("no declared property changes");
    expect(output).not.toContain("secret:");
  });
});

it.effect("emits plain progress through the Effect logger", () => {
  const messages: unknown[] = [];
  const logger = Logger.make<unknown, void>((options) => {
    messages.push(options.message);
  });
  return Effect.gen(function* () {
    const cli = yield* Cli;

    yield* cli.displayPlan(planWith([createNode({}, "Worker")]));

    expect(messages).toEqual([["Plan: 1 to create"], ["[Worker] create"]]);
  }).pipe(Effect.provide(LoggingCli), Effect.provide(Logger.layer([logger])));
});
