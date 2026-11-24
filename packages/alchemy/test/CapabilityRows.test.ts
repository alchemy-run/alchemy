import { describe, expect, it } from "@alchemy.run/test";
import type { Term } from "@/CapabilityGraph.ts";
import { capabilityGroups } from "@/Cli/CapabilityRows.ts";

const sandbox = {
  binding: "Boat.CreateSandbox",
  targets: ["Boat.Snapshot(Checkout)"],
  via: ["AI.Sandboxes"],
};
const term = (id: string, more: Partial<Term> = {}): Term => {
  const at = id.indexOf(":");
  return {
    id,
    kind: id.slice(0, at),
    name: id.slice(at + 1),
    bindings: [],
    references: [],
    ...more,
  };
};
const draw = (terms: ReadonlyArray<Term>) =>
  capabilityGroups(terms).map((group) => [
    group.host,
    group.rows.map(
      (row) =>
        `${"  ".repeat(row.depth)}${row.kind} ${row.label}${row.detail ? ` (${row.detail})` : ""}`,
    ),
  ]);

describe("the rows a plan draws for a runtime's terms", { tags: ["unit"] }, () => {
  it("a process heads a tree, under what hosts it", () => {
    const terms = [
      term("Domain:Board.IssueDetail", { host: "Agents" }),
      term("Process:Answering", { host: "Agents" }),
      term("Process:Triage", {
        host: "Agents",
        references: [
          { relation: "get", to: "Domain:Board.IssueDetail" },
          { relation: "uses", to: "Process:Answering" },
          { relation: "uses", to: "Tool:grep" },
        ],
      }),
      term("Tool:bash", { host: "Agents", bindings: [sandbox] }),
      term("Tool:grep", { host: "Agents", bindings: [sandbox] }),
    ];
    expect(draw(terms)).toEqual([
      [
        "Agents",
        [
          "Process Triage",
          "  Reference Board.IssueDetail (get)",
          "  Process Answering",
          "  Tool grep",
          "    Binding Boat.CreateSandbox (Boat.Snapshot(Checkout) via AI.Sandboxes)",
          "Unused bash",
        ],
      ],
    ]);
  });

  it("a process that uses itself, or one above it, is a reference there", () => {
    const terms = [
      term("Process:A", { references: [{ relation: "uses", to: "Process:B" }] }),
      term("Process:B", { references: [{ relation: "uses", to: "Process:A" }] }),
      term("Process:Top", { references: [{ relation: "uses", to: "Process:A" }] }),
    ];
    expect(draw(terms)).toEqual([
      [undefined, ["Process Top", "  Process A", "    Process B", "      Reference Process A"]],
    ]);
  });

  it("with no process, the tools are drawn", () => {
    expect(draw([term("Tool:leak"), term("Tool:save", { bindings: [sandbox] })])).toEqual([
      [
        undefined,
        [
          "Tool leak",
          "Tool save",
          "  Binding Boat.CreateSandbox (Boat.Snapshot(Checkout) via AI.Sandboxes)",
        ],
      ],
    ]);
  });
});
