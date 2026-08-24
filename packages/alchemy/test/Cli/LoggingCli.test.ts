import { formatPlanLines } from "@/Cli/LoggingCli.ts";
import { describe, expect, test } from "alchemy-test";
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
    expect(output).toContain("  after:\n    retries: 3");
    expect(output).toContain("  before:\n    retries: 2");
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
