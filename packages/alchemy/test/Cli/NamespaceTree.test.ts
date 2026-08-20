import { buildNamespaceTree, flattenTree } from "@/Cli/NamespaceTree.ts";
import { describe, expect, test } from "alchemy-test";
import { createNode, replaceNode, updateNode } from "./PlanTestNodes.ts";

describe("NamespaceTree property changes", () => {
  test("does not attach property changes in compact mode", () => {
    const resource = updateNode(
      { config: { retries: 2 } },
      { config: { retries: 3 } },
      "Api",
    );

    const item = flattenTree(buildNamespaceTree([resource])).find(
      (item) => item.type === "resource",
    );
    expect(item?.propertyChanges).toBeUndefined();
  });

  test("carries update property changes into the flattened TUI model", () => {
    const resource = updateNode(
      { config: { retries: 2 } },
      { config: { retries: 3 } },
      "Api",
    );

    const item = flattenTree(buildNamespaceTree([resource]), {
      includePropertyChanges: true,
    }).find((item) => item.type === "resource");
    expect(item?.propertyChanges).toEqual([
      {
        kind: "update",
        path: "config.retries",
        before: { kind: "literal", value: 2 },
        after: { kind: "literal", value: 3 },
      },
    ]);
  });

  test("carries declared create properties into the flattened TUI model", () => {
    const resource = createNode({ config: { region: "eu-central-1" } }, "Api");

    const item = flattenTree(buildNamespaceTree([resource]), {
      includePropertyChanges: true,
    }).find((item) => item.type === "resource");
    expect(item?.propertyChanges).toEqual([
      {
        kind: "add",
        path: "config.region",
        before: undefined,
        after: { kind: "literal", value: "eu-central-1" },
      },
    ]);
  });

  test("carries an empty detailed diff for non-property replacements", () => {
    const resource = replaceNode({ name: "same" }, { name: "same" });

    const item = flattenTree(buildNamespaceTree([resource]), {
      includePropertyChanges: true,
    }).find((item) => item.type === "resource");
    expect(item?.propertyChanges).toEqual([]);
  });
});
