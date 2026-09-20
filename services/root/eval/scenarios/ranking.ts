import type { Scenario } from "../scenario.ts";

/**
 * SOFT HUMAN RANKING — three scenarios against the staged ranker
 * (Scheduler.ts): the human's drag is a SUGGESTION the pairwise
 * judge weighs, not a law.
 *
 * - `ranking-human`   — signals are WEAK (three near-identical
 *   routine tasks): the judge should follow the dragged order.
 * - `ranking-follows` — a PREREQUISITE case: the human dragged the
 *   dependent task on top; deviating (prerequisite first) is
 *   CORRECT, and the deviation must be recorded on the why line.
 * - `ranking-affinity` — the starved-affinity regression: completed
 *   tasks used to flip `desk` to the reviewer, so the engineer's
 *   `recent` never saw its own finished work; the worked-by memory
 *   must feed fit (signalStarved must be 0) and same-tag chaining
 *   should beat FIFO.
 */
const done = (summary: string) =>
  [
    {
      member: "engineer" as const,
      reply: `Done.\nDISPOSITION: complete — ${summary}`,
    },
    { member: "reviewer" as const, reply: "LGTM.", expect: "approved" as const },
  ] as const;

export const rankingHuman: Scenario = {
  name: "ranking-human",
  description:
    "Weak signals — the judge should follow the human's dragged order",
  arrivals: [
    {
      afterMs: 0,
      title: "chore(org): tidy the desk-view empty state copy",
      body:
        "The desk view's idle line reads awkwardly; reword it. Routine, " +
        "nothing depends on it, no deadline.",
      tags: ["org"],
      humanRank: 3,
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("copy reworded"),
    },
    {
      afterMs: 1,
      title: "chore(org): align the board's column paddings",
      body:
        "The parked column's cards sit 2px lower than ready's. Routine " +
        "polish, nothing depends on it, no deadline.",
      tags: ["org"],
      humanRank: 1,
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("paddings aligned"),
    },
    {
      afterMs: 2,
      title: "chore(org): rename the queue switcher tooltip",
      body:
        "The switcher tooltip still says 'stream'; call it a queue. " +
        "Routine, nothing depends on it, no deadline.",
      tags: ["org"],
      humanRank: 2,
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("tooltip renamed"),
    },
  ],
  // sam dragged t-2 on top, t-3 second, t-1 last — with nothing
  // urgent and no prerequisites, that IS the right order
  truthOrder: [2, 3, 1],
  interactions: [
    "Drag cards on the ready column; with weak signals the judged rank should mirror your order.",
  ],
};

export const rankingFollows: Scenario = {
  name: "ranking-follows",
  description:
    "A prerequisite outranks the human's drag — deviating is CORRECT and recorded",
  arrivals: [
    {
      afterMs: 0,
      title: "feat(forge): whole-tree snapshot API",
      body:
        "Add the endpoint that serves a repository's whole tree in one " +
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
  // sam dragged the dependent task on top; the prerequisite must
  // still go first — the judge should deviate and say why
  truthOrder: [1, 2],
  expectsDeviation: true,
  interactions: [
    "Drag the dependent task to the top — the judge should still rank the prerequisite first and badge the deviation.",
  ],
};

export const rankingAffinity: Scenario = {
  name: "ranking-affinity",
  description:
    "Starved-affinity regression — worked-by memory feeds fit; same-tag chaining beats FIFO",
  affinity: true,
  arrivals: [
    {
      afterMs: 0,
      title: "fix(r2): bucket CORS rules drift on adopt",
      body:
        "Adopting an R2 bucket rewrites CORS from olds instead of " +
        "observed rules — the diff must read the cloud.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("CORS diff reads observed rules"),
    },
    {
      afterMs: 1,
      title: "fix(dynamodb): GSI delta application recreates indexes",
      body:
        "Updating a table with an unchanged GSI still deletes and " +
        "recreates it — the per-aspect diff mis-compares key schemas.",
      tags: ["aws"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("GSI diff keyed on schema equality"),
    },
    {
      afterMs: 2,
      title: "fix(kv): TTLs under a minute are rounded to zero",
      body:
        "KV puts with expirationTtl < 60 silently drop the TTL — clamp " +
        "to the platform minimum and surface the clamp.",
      tags: ["cloudflare"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("TTL clamped to the platform minimum"),
    },
    {
      afterMs: 3,
      title: "fix(sqs): queue attribute sync fights eventual consistency",
      body:
        "getQueueAttributes right after createQueue reads stale state — " +
        "bound a retry on the observe read.",
      tags: ["aws"],
      expect: { disposition: "complete", maxRounds: 1 },
      rounds: done("bounded retry on the observe read"),
    },
  ],
  interactions: [
    "Watch the engineer chain same-tag work after its first settle — its completed tasks now feed its own fit signal.",
  ],
};
