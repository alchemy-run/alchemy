import { describe, expect, it } from "@alchemy.run/test";
import * as Redacted from "effect/Redacted";
import { diffBindings } from "@/Diff.ts";
import { describePlan } from "@/Plan.ts";
import { createNode, updateNode, planWith } from "./Cli/PlanTestNodes.ts";

describe("public planned content metadata", { tags: ["unit", "local"] }, () => {
  it("hashes sorted planned properties and changes when content changes", () => {
    const hash = (props: object) =>
      describePlan(planWith([createNode(props)])).resources[0]?.inputHash;
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    expect(hash({ a: 1 })).not.toBe(hash({ a: 2 }));
    expect(hash({ secret: Redacted.make("one") })).toBe(hash({ secret: Redacted.make("two") }));
    expect(hash({ secret: Redacted.make("one") })).not.toBe(hash({ secret: ["redacted"] }));
    expect(() => hash({ value: Number.NaN })).toThrow();
    expect(hash({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds data and explicit inheritance provenance into the resource hash", () => {
    const node = updateNode({}, {});
    const before = describePlan(planWith([node])).resources[0]?.inputHash;
    node.bindings = diffBindings(
      [{ sid: "TOKEN", data: "old" }],
      [{ sid: "TOKEN", data: "marker", valueSource: "inherit" }],
      { supportsInheritance: true },
    );
    const row = describePlan(planWith([node])).resources[0];
    expect(row?.inputHash).not.toBe(before);
    expect(row?.bindings).toEqual([{ sid: "TOKEN", action: "noop", valueSource: "inherit" }]);
    const unsupported = diffBindings(
      [{ sid: "TOKEN", data: "old" }],
      [{ sid: "TOKEN", data: "marker", valueSource: "inherit" }],
    );
    expect(unsupported[0]?.action).toBe("update");
    const literal = diffBindings(
      [{ sid: "TOKEN", data: "old" }],
      [{ sid: "TOKEN", data: "marker" }],
    );
    expect(literal[0]?.action).toBe("update");
  });
});
