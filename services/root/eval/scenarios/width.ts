import type { Scenario } from "../scenario.ts";

/**
 * DESK WIDTH — a burst of four quick doc tasks at width 2: the trunk
 * takes the first claim, further claims FORK clones that work in
 * parallel and MERGE their learnings home on settle (Desks.ts's
 * fork-and-merge). Scored on branches forked, merges landed on the
 * trunk, and every task reaching done.
 */
const done = (summary: string) =>
  [
    {
      member: "engineer" as const,
      reply: `Written.\nDISPOSITION: complete — ${summary}`,
    },
    { member: "reviewer" as const, reply: "LGTM.", expect: "approved" as const },
  ] as const;

export const width: Scenario = {
  name: "width",
  description:
    "Width-2 parallel burst of four doc tasks — fork/merge and clone accounting",
  width: 2,
  arrivals: [
    {
      afterMs: 0,
      title: "docs(tasks): document the disposition contract",
      body:
        "Write the DISPOSITION: complete/park/handoff contract into the tasks " +
        "docs page — one section, three examples.",
      tags: ["org"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("disposition contract documented"),
    },
    {
      afterMs: 1,
      title: "docs(tasks): document the board's state machine",
      body:
        "Document the legal task transitions (TasksDO's matrix) with the " +
        "timeline event each hop records.",
      tags: ["org"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("state machine documented"),
    },
    {
      afterMs: 2,
      title: "docs(tasks): document desk width and fork/merge",
      body:
        "Explain the width dial: linear default, clone forking at the trunk " +
        "tip, and the quiet merge-home message.",
      tags: ["org"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("width and fork/merge documented"),
    },
    {
      afterMs: 3,
      title: "docs(tasks): document the dispatch budget",
      body:
        "Document the 20/hour per-queue dispatch budget and the org-wide " +
        "working-desk ceiling, and what a spend refusal looks like.",
      tags: ["org"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("budgets documented"),
    },
  ],
  interactions: [
    "The engineer desk should show two working chips at once; the second slot's session key carries a #clone suffix.",
  ],
};
