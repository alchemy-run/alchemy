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
  it("every term is drawn once: a process with what it reaches and refers to, then the rest", () => {
    const terms = [
      term("Domain:Board.IssueDetail"),
      term("Policy:IssueWork", {
        bindings: [{ binding: "AWS.SQS.SendMessage", targets: ["AWS.SQS.Queue(jobs)"], via: [] }],
        references: [{ relation: "uses", to: "Process:Triage" }],
      }),
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
          "Term Answering (Process)",
          "Term Triage (Process)",
          "  Reaches Boat.CreateSandbox",
          "  Reference Board.IssueDetail (get)",
          "  Reference Process Answering",
          "  Reference Tool grep",
          "Term bash (Tool)",
          "  Binding Boat.CreateSandbox (Boat.Snapshot(Checkout) via AI.Sandboxes)",
          "Term grep (Tool)",
          "  Binding Boat.CreateSandbox (Boat.Snapshot(Checkout) via AI.Sandboxes)",
        ],
      ],
      [
        undefined,
        [
          "Term IssueWork (Policy)",
          "  Reference Process Triage",
          "  Binding AWS.SQS.SendMessage (AWS.SQS.Queue(jobs))",
        ],
      ],
    ]);
  });

  it("processes that use each other are each drawn once", () => {
    const terms = [
      term("Process:A", { references: [{ relation: "uses", to: "Process:B" }] }),
      term("Process:B", { references: [{ relation: "uses", to: "Process:A" }] }),
    ];
    expect(draw(terms)).toEqual([
      [
        undefined,
        ["Term A (Process)", "  Reference Process B", "Term B (Process)", "  Reference Process A"],
      ],
    ]);
  });
});
