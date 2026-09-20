import type { Scenario } from "../scenario.ts";

/**
 * WALK QUALITY — four scenarios against the walk ranker
 * (Scheduler.ts + judge/Walk.ts): does the walk DRILL when hidden
 * content decides the order, stay its hand when the cards suffice,
 * and keep the human-drag calibration end to end?
 *
 * - `walk-drill`   — a MISLEADING card: a routine-looking chore
 *   whose clipped body hides that it is the PREREQUISITE of the
 *   attractive feature next to it. The walk should open the body
 *   and rank the chore first (drill recall is the score).
 * - `walk-clear`   — a clear board: short bodies, an obvious urgent
 *   interrupt. The cards decide it; any drill is a miss.
 * - `walk-drag`    — weak signals: three near-identical chores, sam
 *   dragged an order; the walk should follow it.
 * - `walk-deviate` — sam dragged the dependent task on top of its
 *   visible prerequisite; deviating (with the badge) is CORRECT.
 */
const done = (summary: string) =>
  [
    {
      member: "engineer" as const,
      reply: `Done.\nDISPOSITION: complete — ${summary}`,
    },
    { member: "reviewer" as const, reply: "LGTM.", expect: "approved" as const },
  ] as const;

export const walkDrill: Scenario = {
  name: "walk-drill",
  description:
    "A misleading card — only its FULL body reveals the prerequisite; the walk should drill and reorder",
  arrivals: [
    {
      afterMs: 0,
      title: "chore(forge): bump the tree-walker dependency",
      // the clipped card (320 chars) reads as pure routine hygiene;
      // only the FULL body reveals the hard prerequisite
      body:
        "Bump the internal tree-walker package from 4.11 to 4.12. " +
        "Update the lockfile, re-run the codegen that consumes its AST " +
        "types, and confirm the snapshot fixtures still parse. Version " +
        "4.12 is a minor with the usual changelog: parser performance, " +
        "a handful of upstream bugfixes, refreshed type exports. " +
        "Standard dependency hygiene, the kind of chore that usually " +
        "waits at the back of the queue. One thing the changelog " +
        "buries, though: 4.12 is the release that ships the whole-tree " +
        "snapshot endpoint, and the code-browser sidebar task on this " +
        "board STRICTLY depends on that endpoint existing — nothing in " +
        "the sidebar work can even start until this bump lands and " +
        "deploys. It is the hard PREREQUISITE of the sidebar feature; " +
        "landing it second wastes a full desk round on a task that " +
        "cannot proceed.",
      tags: ["forge"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("tree-walker bumped — snapshot endpoint live"),
    },
    {
      afterMs: 1,
      title: "feat(forge): code browser sidebar",
      body:
        "Build the code browser's sidebar tree. High-visibility " +
        "feature work on the forge UI.",
      tags: ["forge"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("sidebar renders"),
    },
    {
      afterMs: 2,
      title: "chore(org): tidy the desk-view empty state copy",
      body: "Reword the desk view's idle line. Routine, no deadline.",
      tags: ["org"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("copy reworded"),
    },
  ],
  // the chore is the hidden prerequisite — it must go first
  truthOrder: [1, 2, 3],
  walk: { shouldDrill: [1] },
  interactions: [
    "Watch the walk open the chore's clipped body and rank it above the feature.",
  ],
};

export const walkClear: Scenario = {
  name: "walk-clear",
  description:
    "A clear board — short cards, an obvious interrupt; the walk should NOT drill",
  arrivals: [
    {
      afterMs: 0,
      title: "fix(kv): list pagination cursor expires early",
      body: "Cursors expire after 60s instead of 5 minutes. Routine.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("cursor TTL fixed"),
    },
    {
      afterMs: 1,
      title: "fix(workers): deploys failing on main — every push red",
      body:
        "Every deploy fails at upload; the whole pipeline is blocked " +
        "for everyone until this lands.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("pipeline unblocked"),
    },
  ],
  // the outage interrupts — and the cards alone say so
  truthOrder: [2, 1],
  walk: { forbidDrill: true },
  interactions: ["The cards suffice — no magnifier markers should appear."],
};

export const walkDrag: Scenario = {
  name: "walk-drag",
  description:
    "Weak signals — the walk should follow sam's dragged order without drilling for more",
  arrivals: [
    {
      afterMs: 0,
      title: "chore(org): align the board's column paddings",
      body: "The parked column sits 2px low. Routine polish.",
      tags: ["org"],
      humanRank: 2,
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("paddings aligned"),
    },
    {
      afterMs: 1,
      title: "chore(org): rename the queue switcher tooltip",
      body: "The tooltip still says 'stream'; call it a queue. Routine.",
      tags: ["org"],
      humanRank: 1,
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("tooltip renamed"),
    },
    {
      afterMs: 2,
      title: "chore(org): tidy the desk-view empty state copy",
      body: "Reword the desk view's idle line. Routine, no deadline.",
      tags: ["org"],
      humanRank: 3,
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("copy reworded"),
    },
  ],
  // sam's dragged order IS the right order on a weak-signal board
  truthOrder: [2, 1, 3],
  interactions: [
    "Drag cards on the ready column; with weak signals the walk should mirror your order.",
  ],
};

export const walkDeviate: Scenario = {
  name: "walk-deviate",
  description:
    "Sam dragged the dependent task on top — the walk must deviate to the prerequisite and badge it",
  arrivals: [
    {
      afterMs: 0,
      title: "feat(forge): whole-tree snapshot API",
      body:
        "Add the endpoint serving a repository's whole tree in one " +
        "response. The code-browser rendering task depends on this " +
        "landing first — it is the prerequisite.",
      tags: ["forge"],
      humanRank: 2,
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("tree snapshot API shipped"),
    },
    {
      afterMs: 1,
      title: "feat(forge): code browser renders from the tree snapshot API",
      body:
        "Render the code browser's sidebar from the whole-tree snapshot " +
        "API. BLOCKED until the snapshot API task lands — this strictly " +
        "follows it and cannot start before it.",
      tags: ["forge"],
      humanRank: 1,
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("browser renders from the snapshot API"),
    },
  ],
  // the prerequisite must still go first — deviate, out loud
  truthOrder: [1, 2],
  expectsDeviation: true,
  interactions: [
    "Drag the dependent task to the top — the walk should still rank the prerequisite first and badge the deviation.",
  ],
};
