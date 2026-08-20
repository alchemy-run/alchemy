import { formatPlanLines } from "@/Cli/LoggingCli.ts";
import * as Output from "@/Output.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  createNode,
  deleteNode,
  planWith,
  replaceNode,
  updateNode,
} from "./PlanTestNodes.ts";

describe("formatPlanLines", () => {
  test("keeps the existing compact output unchanged by default", () => {
    const lines = formatPlanLines(
      planWith([
        updateNode({ value: "old" }, { value: "new" }, "First"),
        replaceNode({ engine: "v1" }, { engine: "v2" }, "Second"),
      ]),
    );

    expect(lines).toEqual([
      "Plan: 1 to update, 1 to replace",
      "[First] update",
      "[Second] replace",
    ]);
  });

  test("shows property details for an update", () => {
    const lines = formatPlanLines(
      planWith([
        updateNode(
          { compatibilityDate: "2026-01-01" },
          { compatibilityDate: "2026-08-19" },
        ),
      ]),
      { detailed: true },
    );
    const row = lines.find((line) => line.includes("compatibilityDate"));
    expect(row).toContain('"2026-01-01" → "2026-08-19"');
    expect(lines.join("\n")).not.toContain("PROPERTY");
    expect(lines.join("\n")).not.toContain("│");
  });

  test("shows explicit before and after values for additions and removals", () => {
    const lines = formatPlanLines(
      planWith([updateNode({ removed: "old" }, { added: "new" })]),
      { detailed: true },
    );
    expect(lines.find((line) => line.includes("added"))).toContain(
      '(not set) → "new"',
    );
    expect(lines.find((line) => line.includes("removed"))).toContain(
      '"old" → (not set)',
    );
  });

  test("uses a stacked before and after layout in narrow terminals", () => {
    const lines = formatPlanLines(
      planWith([updateNode({ port: 80 }, { port: 443 })]),
      { detailed: true, columns: 80 },
    );
    expect(lines).toContain("  ~ port");
    expect(lines).toContain("      ├─ before  80");
    expect(lines).toContain("      └─ after   443");
  });

  test("starts values directly after each property path", () => {
    const lines = formatPlanLines(
      planWith([
        updateNode(
          { short: "a", mediumPath: "m" },
          { short: "b", mediumPath: "n" },
          "First",
        ),
        updateNode(
          { muchLongerProperty: "before" },
          { muchLongerProperty: "after" },
          "Second",
        ),
      ]),
      { detailed: true, columns: 160 },
    );
    const rows = ["short", "mediumPath", "muchLongerProperty"].map((path) =>
      lines.find((line) => line.includes(path))!,
    );
    expect(rows[0]).toContain('short  "a"');
    expect(rows[1]).toContain('mediumPath  "m"');
    expect(rows[0].indexOf('"a"')).not.toBe(rows[1].indexOf('"m"'));
    expect(rows[2].indexOf('"before"')).toBeGreaterThan(rows[0].indexOf('"a"'));
    expect(Math.max(...rows.map((row) => row.length))).toBeLessThan(60);
    expect(lines.filter((line) => line === "")).toHaveLength(2);
  });

  test("is honest when update and replace have no declared property changes", () => {
    const lines = formatPlanLines(
      planWith([
        updateNode({ name: "same" }, { name: "same" }, "UpdateWorker"),
        replaceNode({ name: "same" }, { name: "same" }, "ReplaceWorker"),
      ]),
      { detailed: true },
    );
    expect(lines.filter((line) => line.includes("no declared"))).toEqual([
      "  no declared property changes",
      "  no declared property changes",
    ]);
  });

  test("keeps create and delete rows compact by default", () => {
    const plan = planWith(
      [createNode({ createdOnly: true })],
      [deleteNode({ deletedOnly: true }, "OldWorker")],
    );
    const lines = formatPlanLines(plan);
    expect(lines).toEqual([
      "Plan: 1 to create, 1 to delete",
      "[OldWorker] delete",
      "[Worker] create",
    ]);
    expect(lines.join("\n")).not.toContain("createdOnly");
    expect(lines.join("\n")).not.toContain("deletedOnly");
  });

  test("shows safe declared properties for a detailed create", () => {
    let outputEvaluated = false;
    let effectExecuted = false;
    const plan = planWith(
      [
        createNode({
          endpoint: Output.fromEffect(
            Effect.sync(() => {
              outputEvaluated = true;
              return "resolved-output";
            }),
          ),
          handler: Effect.sync(() => {
            effectExecuted = true;
            return "computed-handler";
          }),
          name: "worker",
          token: Redacted.make("secret-token"),
        }),
      ],
      [deleteNode({ deletedOnly: true }, "OldWorker")],
    );
    const output = formatPlanLines(plan, { detailed: true }).join("\n");

    expect(output).toContain("+ endpoint  (known after apply)");
    expect(output).toContain("+ handler  (computed)");
    expect(output).toContain('+ name  "worker"');
    expect(output).toContain("+ token  (redacted)");
    expect(output).not.toContain("(not set)");
    expect(output).not.toContain("deletedOnly");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("resolved-output");
    expect(outputEvaluated).toBe(false);
    expect(effectExecuted).toBe(false);
  });
});
