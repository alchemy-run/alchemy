/**
 * The swarm scenario BACKLOG — conversations written down before their
 * walkers exist (rev-4 doctrine: concrete tests, no scenario schema).
 * Each todo names the shape and its expected orchestration; promotion
 * to a real test = copying pr-burst.test.ts's explicit-world style.
 */
import { test } from "bun:test";

const todo = (name: string) => test.todo(name, () => {});

// P2 — engineering/Cluster.ts
todo(
  "issue-cluster: six near-duplicate issues cluster into one thread with a sub-thread per distinct root cause (emergent buckets — wide 'which group or new?' pass)",
);
todo(
  "fork-join: 'have the engineer and reviewer look independently' forks both in parallel; contradictory answers make the join dispatch the manager to reconcile",
);
todo(
  "series: five PRs stacking on each other are reviewed in order, each review carrying the previous verdict",
);
todo(
  "recursive split: a PR whose review finds three separable problems spawns three sub-threads under it",
);

// P3 — intake
todo(
  "attach-vs-open: a new burst about last week's OOM ATTACHES to that thread (Scout's search at intake) instead of opening a new tree",
);
todo("single event bypasses the batcher and takes today's path unchanged");

// gate.test.ts extensions (family: channel chatter)
todo(
  "escalation: a grumble that stays inline for two messages tips into a thread on the third ('ok this keeps happening')",
);
todo(
  "pile-on: '+1 same here' on a bug conversation joins the existing thread instead of opening another",
);
