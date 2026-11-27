import { describe, expect, test } from "@alchemy.run/test";
import { buildNamespaceTree, flattenTree } from "@/Cli/NamespaceTree.ts";
import { createNode, replaceNode, updateNode } from "./PlanTestNodes.ts";

describe("NamespaceTree YAML properties", { tags: ["unit", "local"] }, () => {
  test("does not attach details in compact mode", () => {
    const [item] = flattenTree(
      buildNamespaceTree([updateNode({ config: { retries: 2 } }, { config: { retries: 3 } })]),
    );
    expect(item?.propertyYaml).toBeUndefined();
  });

  test("attaches safe structured YAML in detailed mode", () => {
    const items = flattenTree(
      buildNamespaceTree([
        createNode({ config: { region: "iad" } }, "Api"),
        updateNode({ retries: 2 }, { retries: 3 }, "Worker"),
      ]),
      { includePropertyYaml: true },
    );
    expect(items.find((item) => item.id === "Api")?.propertyYaml?.lines).toEqual([
      "properties:",
      "  config:",
      "    region: iad",
    ]);
    expect(items.find((item) => item.id === "Worker")?.propertyYaml?.lines).toEqual([
      "properties:",
      "-   retries: 2",
      "+   retries: 3",
    ]);
  });

  test("attaches drift details in compact mode", () => {
    const node = updateNode({ value: "declared" }, { value: "declared" });
    node.drift = {
      expected: { value: "declared" },
      actual: { value: "changed-out-of-band" },
    };
    const [item] = flattenTree(buildNamespaceTree([node]));
    expect(item?.propertyYaml?.lines).toEqual([
      "- value: declared",
      "+ value: changed-out-of-band",
    ]);
  });

  test("represents non-property replacement details honestly", () => {
    const [item] = flattenTree(
      buildNamespaceTree([replaceNode({ name: "same" }, { name: "same" })]),
      { includePropertyYaml: true },
    );
    expect(item?.propertyYaml).toBeUndefined();
  });
});

describe("a runtime's terms in the plan tree", { tags: ["unit"] }, () => {
  test("a model's own bindings are grouped under it, and a host's terms under its row", () => {
    const node = createNode({}, "Worker");
    const bind = (sid: string) => ({ sid, action: "create" }) as never;
    node.bindings = [
      bind("AI"),
      bind("Agents"),
      bind("Board.IssueAggregate"),
      bind("Board.IssueView"),
    ];
    node.capabilities = [
      {
        id: "Model:Board",
        kind: "Model",
        name: "Board",
        bindings: [],
        references: [],
        resources: ["Board.IssueAggregate", "Board.IssueView"],
      },
      {
        id: "Process:Triage",
        kind: "Process",
        name: "Triage",
        host: "Agents",
        bindings: [],
        references: [],
      },
    ];
    expect(
      flattenTree(buildNamespaceTree([node])).map(
        (item) => `${"  ".repeat(item.depth)}${item.type} ${item.id}`,
      ),
    ).toEqual([
      "resource Worker",
      "  binding Agents",
      "    capability Triage",
      "  binding AI",
      "  capability Board",
      "    binding IssueAggregate",
      "    binding IssueView",
    ]);
  });
});
