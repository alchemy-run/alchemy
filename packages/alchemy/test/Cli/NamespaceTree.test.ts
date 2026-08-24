import { buildNamespaceTree, flattenTree } from "@/Cli/NamespaceTree.ts";
import { describe, expect, test } from "alchemy-test";
import { createNode, replaceNode, updateNode } from "./PlanTestNodes.ts";

describe("NamespaceTree YAML properties", () => {
  test("does not attach details in compact mode", () => {
    const [item] = flattenTree(
      buildNamespaceTree([
        updateNode({ config: { retries: 2 } }, { config: { retries: 3 } }),
      ]),
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
    expect(
      items.find((item) => item.id === "Api")?.propertyYaml?.lines,
    ).toEqual(["properties:", "  config:", "    region: iad"]);
    expect(
      items.find((item) => item.id === "Worker")?.propertyYaml?.lines,
    ).toEqual(["before:", "  retries: 2", "after:", "  retries: 3"]);
  });

  test("represents non-property replacement details honestly", () => {
    const [item] = flattenTree(
      buildNamespaceTree([replaceNode({ name: "same" }, { name: "same" })]),
      { includePropertyYaml: true },
    );
    expect(item?.propertyYaml).toBeUndefined();
  });
});
