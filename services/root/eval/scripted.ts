/**
 * THE SCRIPTED RUNNER — drive one scenario through the desk world
 * (eval/world.ts, the same fixture desk-loop.test.ts asserts): desks
 * answer from the scenario's scripts, while the CONTROL PLANE is
 * judged by the REAL TypeSafe System One when the key is present —
 * the router's tag Choice per arrival, the walk ranker's pick walks
 * (whole-board pick+probe fan-outs, drills, two-option gates) per
 * re-rank, the forgotten-line disposition Choice, and the review
 * Noul. Without the key everything degrades to the scripted/hint-
 * then-FIFO fallbacks and the judged metrics are skipped with a
 * notice.
 */
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import { pump } from "../src/tasks/Desks.ts";
import { DEMANDS_CHANGES } from "../src/tasks/Review.ts";
import { routeTask } from "../src/tasks/Router.ts";
import { rerank } from "../src/tasks/Scheduler.ts";
import {
  confidenceOf,
  hasTypeSafeKey,
  noulOf,
  recordingQuery,
} from "./judge.ts";
import {
  confusionOf,
  type JudgedMiss,
  type ScenarioReport,
  type TaskReport,
} from "./report.ts";
import {
  stateOfDisposition,
  truthTagOf,
  type Arrival,
  type Scenario,
} from "./scenario.ts";
import { deskWorld, QUEUE } from "./world.ts";

/** Desk-loop states the scripted runner treats as settled — `inbox`
 *  is a handoff's landing (a human re-routes; no desk claims it). */
const TERMINAL = new Set(["done", "parked", "dropped", "inbox"]);

/** `judgeDisposition`'s confidence bar (Desks.ts keeps it private). */
const DISPOSITION_SURE = 0.6;

const run = <A>(effect: Effect.Effect<A, never, RuntimeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(RuntimeContext.phantom)));

export interface RunOptions {
  /** Cap the arrivals (the live smoke's small-batch dial). */
  readonly cap?: number;
  /** Override the scenario's engineer-desk width. */
  readonly width?: number;
}

export const runScripted = async (
  scenario: Scenario,
  options: RunOptions = {},
): Promise<ScenarioReport> => {
  const startedAt = new Date().toISOString();
  const startMs = performance.now();
  const judged = hasTypeSafeKey;
  const recorded = judged ? recordingQuery() : undefined;
  const world = deskWorld(
    recorded === undefined ? {} : { query: recorded.query },
  );

  const width = options.width ?? scenario.width ?? 1;
  if (width > 1) world.setWidth(QUEUE.worker.slug, width);

  const arrivals = [...scenario.arrivals]
    .sort((a, b) => a.afterMs - b.afterMs)
    .slice(0, options.cap ?? scenario.arrivals.length);
  const ids = new Map<Arrival, string>();
  arrivals.forEach((arrival, index) => ids.set(arrival, `t-${index + 1}`));

  const misses: JudgedMiss[] = [];
  const notes: string[] = [];
  if (!judged) {
    notes.push(
      "TYPESAFE_API_KEY absent — control plane ran on scripted/FIFO fallbacks; judged metrics skipped",
    );
  }

  // ── the router, judged per arrival (scripted filing bypasses
  //    Intake, so the same routeTask is run here explicitly) ────────
  const routingPairs: Array<{ chose: string; truth: string }> = [];
  let routingHits = 0;
  if (recorded !== undefined) {
    for (const arrival of arrivals) {
      const routed = await run(
        routeTask(recorded.query, {
          title: arrival.title,
          body: arrival.body,
        }),
      );
      const chose = routed ?? "untagged";
      const truth = truthTagOf(arrival);
      routingPairs.push({ chose, truth });
      if (chose === truth) {
        routingHits += 1;
      } else {
        const exchange = recorded.exchanges.at(-1);
        if (exchange !== undefined) {
          misses.push({
            edge: "routing",
            task: ids.get(arrival),
            expected: truth,
            got: chose,
            ...(confidenceOf(exchange, "tag") === undefined
              ? {}
              : { confidence: confidenceOf(exchange, "tag") }),
            exchange,
          });
        }
      }
    }
  }

  // ── file with GROUND-TRUTH tags (affinity needs correct areas on
  //    the cards regardless of what the router just chose) ──────────
  for (const arrival of arrivals) {
    const id = ids.get(arrival)!;
    world.file(id, arrival.title, arrival.body, arrival.tags ?? []);
    for (const round of arrival.rounds ?? []) {
      world.answerFor(round.member, id, round.reply);
    }
  }

  // ── replay the human's drags: hinted arrivals dragged into place
  //    bottom-up (each drag writes one hint row, like the board) ───
  const hinted = arrivals
    .filter((arrival) => arrival.humanRank !== undefined)
    .sort((a, b) => b.humanRank! - a.humanRank!);
  for (const arrival of hinted) {
    world.reorder(ids.get(arrival)!, { position: 0 });
  }

  // ── ARRIVAL is a re-rank trigger; settles re-rank themselves ─────
  const board = world.deps.board(QUEUE.slug);
  await run(rerank(world.deps.query, board, QUEUE.worker.slug));

  // ── the loop: pump until every task settles or nothing moves ─────
  const signature = () =>
    world
      .all()
      .map((task) => `${task.id}:${task.state}`)
      .join(",");
  for (let round = 0; round < 6; round++) {
    const before = signature();
    await run(pump(world.deps, QUEUE));
    const settled = world.all().every((task) => TERMINAL.has(task.state));
    if (settled || signature() === before) break;
  }

  // ── the walk ranker, scored ──────────────────────────────────────
  // Ranking is judged by its OUTPUT: the engineer desk's actual
  // CLAIM ORDER (the materialized rank's top pops on each claim).
  // Affinity is scored per claim: when a not-yet-claimed task shared
  // a tag with already-worked tasks and another didn't, claiming a
  // sharing one is affinity-optimal.
  const walkAsks = (recorded?.exchanges ?? []).filter(
    (exchange) => exchange.kind === "next",
  );
  const pairAsks = (recorded?.exchanges ?? []).filter(
    (exchange) => exchange.kind === "pair",
  );
  const engineerClaims = world.dispatches.filter(
    (entry) =>
      entry.member === QUEUE.worker.slug && entry.ask.startsWith("[task"),
  );
  let applicable = 0;
  let affinityOptimal = 0;
  if (judged) {
    engineerClaims.forEach((claim, index) => {
      if (index === 0) return;
      const workedTags = new Set(
        engineerClaims
          .slice(0, index)
          .flatMap((prev) => world.task(prev.task).tags),
      );
      const remaining = [
        ...new Set(engineerClaims.slice(index).map((entry) => entry.task)),
      ].map((id) => world.task(id));
      const sharing = remaining.filter((task) =>
        task.tags.some((tag) => workedTags.has(tag)),
      );
      if (sharing.length === 0 || sharing.length === remaining.length) return;
      applicable += 1;
      if (world.task(claim.task).tags.some((tag) => workedTags.has(tag))) {
        affinityOptimal += 1;
      } else if (scenario.affinity === true) {
        // only an affinity-subject scenario turns a non-adjacent
        // claim into a MISS; elsewhere the ratio stays informational
        // (a heterogeneous board may rightly rank urgency over tags)
        misses.push({
          edge: "scheduler",
          task: claim.task,
          expected: `one of [${sharing.map((task) => task.id).join(", ")}] (same-tag adjacency)`,
          got: claim.task,
        });
      }
    });
  }

  // starvation probe (code-level, judged or not): a deskState read
  // whose `recent` carried NONE of the tags of tasks the engineer
  // had already worked-and-settled means the affinity signal died
  // upstream of any prompt — the worked-by regression
  const settledBefore = (at: number): Set<string> => {
    const tags = new Set<string>();
    for (const task of world.all()) {
      const events = world.eventsOf(task.id);
      const started = events.find(
        (event) =>
          event.kind === "started" && event.actor === QUEUE.worker.slug,
      );
      if (started === undefined || started.at >= at) continue;
      const settled = events.some(
        (event) =>
          event.at < at &&
          event.at > started.at &&
          ["review_requested", "parked", "done", "routed"].includes(
            event.kind,
          ),
      );
      if (settled) for (const tag of task.tags) tags.add(tag);
    }
    return tags;
  };
  const signalStarved = world.snapshots.filter((snapshot) => {
    if (snapshot.desk !== QUEUE.worker.slug) return false;
    const workedTags = settledBefore(snapshot.at);
    return (
      workedTags.size > 0 &&
      !snapshot.recent.some((entry) =>
        entry.tags.some((tag) => workedTags.has(tag)),
      )
    );
  }).length;
  if (signalStarved > 0) {
    misses.push({
      edge: "scheduler",
      expected: "desk.recent carries the tags of its worked-and-settled tasks",
      got: `signal starved ×${signalStarved} (the worked-by memory regressed)`,
    });
  }

  // ── ranking: deviations, drills, churn, the truth order ──────────
  const deviationWhys = [
    ...new Set(
      world.rankWrites.flatMap((write) =>
        write.entries
          .filter((entry) => entry.rankWhy.startsWith("judge:"))
          .map((entry) => `${entry.id} ${entry.rankWhy}`),
      ),
    ),
  ];

  // every content id the walks drilled into, across all re-ranks
  const drilled = [
    ...new Set(
      world.rankWrites.flatMap((write) =>
        write.entries.flatMap((entry) =>
          (entry.trace ?? []).flatMap((step) => step.expanded),
        ),
      ),
    ),
  ];
  const drillTruth = scenario.walk?.shouldDrill?.map(
    (index) => `t-${index}`,
  );
  if (judged && drillTruth !== undefined) {
    for (const id of drillTruth) {
      if (!drilled.includes(id)) {
        misses.push({
          edge: "walk",
          task: id,
          expected: `the walk drills into ${id}'s hidden content`,
          got: `no drill (drilled: [${drilled.join(", ")}])`,
        });
      }
    }
  }
  if (judged && scenario.walk?.forbidDrill === true && drilled.length > 0) {
    misses.push({
      edge: "walk",
      expected: "no drills — the visible cards suffice",
      got: `drilled [${drilled.join(", ")}]`,
    });
  }

  // CHURN: relative-order flips between consecutive re-ranks among
  // tasks present in both, split by whether an event between the
  // writes touched either task — always-fresh re-ranking must move
  // for a reason (informational, never a hard fail)
  const allEvents = world.allEvents();
  let churnTransitions = 0;
  let churnMoved = 0;
  let churnUnjustified = 0;
  for (let index = 1; index < world.rankWrites.length; index++) {
    const prev = world.rankWrites[index - 1]!;
    const next = world.rankWrites[index]!;
    const prevOrder = prev.entries.map((entry) => entry.id);
    const nextOrder = next.entries.map((entry) => entry.id);
    const common = prevOrder.filter((id) => nextOrder.includes(id));
    if (common.length < 2) continue;
    churnTransitions += 1;
    const touched = new Set(
      allEvents
        .filter((event) => event.at > prev.at && event.at <= next.at)
        .map((event) => event.task),
    );
    for (let a = 0; a < common.length; a++) {
      for (let b = a + 1; b < common.length; b++) {
        const x = common[a]!;
        const y = common[b]!;
        const before = prevOrder.indexOf(x) < prevOrder.indexOf(y);
        const after = nextOrder.indexOf(x) < nextOrder.indexOf(y);
        if (before !== after) {
          churnMoved += 1;
          if (!touched.has(x) && !touched.has(y)) churnUnjustified += 1;
        }
      }
    }
  }
  const claimedOrder = [
    ...new Set(engineerClaims.map((entry) => entry.task)),
  ];
  const truthOrder =
    scenario.truthOrder === undefined
      ? undefined
      : scenario.truthOrder.map((index) => `t-${index}`);
  const orderMatched =
    truthOrder !== undefined &&
    truthOrder.length === claimedOrder.length &&
    truthOrder.every((id, index) => claimedOrder[index] === id);
  if (judged && truthOrder !== undefined && !orderMatched) {
    misses.push({
      edge: "ranking",
      expected: `claim order [${truthOrder.join(" ")}]`,
      got: `[${claimedOrder.join(" ")}]`,
      ...(pairAsks.length > 0 ? { exchange: pairAsks.at(-1)! } : {}),
    });
  }
  if (judged && scenario.expectsDeviation === true && deviationWhys.length === 0) {
    misses.push({
      edge: "ranking",
      expected: "a recorded judge deviation from the human's dragged order",
      got: "none — the judge followed the drag",
    });
  }

  // ── judged replies: forgotten-line dispositions + review nouls ───
  const roundByReply = new Map<
    string,
    { arrival: Arrival; expect: string }
  >();
  for (const arrival of arrivals) {
    for (const round of arrival.rounds ?? []) {
      if (round.expect !== undefined) {
        roundByReply.set(round.reply, { arrival, expect: round.expect });
      }
    }
  }
  let dispositionTotal = 0;
  let dispositionHits = 0;
  let reviewTotal = 0;
  let reviewHits = 0;
  for (const exchange of recorded?.exchanges ?? []) {
    if (exchange.kind === "disposition") {
      const reply = String(
        (exchange.state as { reply?: unknown }).reply ?? "",
      );
      const truth = roundByReply.get(reply);
      if (truth === undefined) continue;
      dispositionTotal += 1;
      const confidence = confidenceOf(exchange, "disposition") ?? 0;
      const effective =
        confidence >= DISPOSITION_SURE
          ? String(exchange.value.disposition ?? "complete")
          : "complete";
      if (effective === truth.expect) {
        dispositionHits += 1;
      } else {
        misses.push({
          edge: "disposition",
          task: ids.get(truth.arrival),
          expected: truth.expect,
          got: effective,
          confidence,
          exchange,
        });
      }
    }
    if (exchange.kind === "changes") {
      const review = String(
        (exchange.state as { review?: unknown }).review ?? "",
      );
      const truth = roundByReply.get(review);
      if (truth === undefined) continue;
      reviewTotal += 1;
      const noul = noulOf(exchange, "changes") ?? 0;
      const verdict = noul >= DEMANDS_CHANGES ? "changes_requested" : "approved";
      if (verdict === truth.expect) {
        reviewHits += 1;
      } else {
        misses.push({
          edge: "review",
          task: ids.get(truth.arrival),
          expected: truth.expect,
          got: `${verdict} (noul ${noul.toFixed(2)})`,
          exchange,
        });
      }
    }
  }

  // ── outcomes ─────────────────────────────────────────────────────
  const tasks: TaskReport[] = arrivals.map((arrival) => {
    const id = ids.get(arrival)!;
    const task = world.task(id);
    const rounds = world.dispatches.filter(
      (entry) => entry.member === QUEUE.worker.slug && entry.task === id,
    ).length;
    return {
      id,
      title: arrival.title,
      truthTag: truthTagOf(arrival),
      ...(routingPairs.length > 0
        ? { routedTag: routingPairs[arrivals.indexOf(arrival)]!.chose }
        : {}),
      ...(arrival.expect.disposition === undefined
        ? {}
        : { expectedDisposition: arrival.expect.disposition }),
      finalState: task.state,
      rounds,
      ...(arrival.expect.maxRounds === undefined
        ? {}
        : { maxRounds: arrival.expect.maxRounds }),
      ...(task.parkedReason === undefined
        ? {}
        : { parkedReason: task.parkedReason }),
    };
  });
  const expected = tasks.filter(
    (task) => task.expectedDisposition !== undefined,
  );
  const matched = expected.filter(
    (task) =>
      task.finalState ===
      stateOfDisposition(
        task.expectedDisposition as "complete" | "park" | "handoff",
      ),
  ).length;
  const all = world.all();
  const recoveries = arrivals
    .map((arrival) => ids.get(arrival)!)
    .flatMap((id) => world.eventsOf(id))
    .filter(
      (event) =>
        event.data !== undefined && event.data.startsWith("recovered:"),
    ).length;

  return {
    runId: `scripted-${startedAt.replaceAll(/[:.]/g, "-")}`,
    scenario: scenario.name,
    mode: "scripted",
    judged,
    startedAt,
    wallMs: Math.round(performance.now() - startMs),
    tasks,
    metrics: {
      routing: {
        total: routingPairs.length,
        hits: routingHits,
        confusion: confusionOf(routingPairs),
      },
      scheduler: {
        asks: walkAsks.length + pairAsks.length,
        applicable,
        affinityOptimal,
        signalStarved,
      },
      ranking: {
        walks: walkAsks.length,
        pairs: pairAsks.length,
        deviations: deviationWhys.length,
        deviationWhys,
        ...(scenario.walk === undefined && drilled.length === 0
          ? {}
          : {
              drill: {
                drilled,
                ...(drillTruth === undefined ? {} : { truth: drillTruth }),
                ...(drillTruth === undefined || drilled.length === 0
                  ? {}
                  : {
                      precision:
                        drilled.filter((id) => drillTruth.includes(id))
                          .length / drilled.length,
                    }),
                ...(drillTruth === undefined || drillTruth.length === 0
                  ? {}
                  : {
                      recall:
                        drillTruth.filter((id) => drilled.includes(id))
                          .length / drillTruth.length,
                    }),
              },
            }),
        churn: {
          transitions: churnTransitions,
          movedPairs: churnMoved,
          unjustifiedPairs: churnUnjustified,
        },
        ...(truthOrder === undefined
          ? {}
          : {
              order: {
                truth: truthOrder,
                claimed: claimedOrder,
                matched: orderMatched,
              },
            }),
      },
      disposition: { total: dispositionTotal, hits: dispositionHits },
      review: { total: reviewTotal, hits: reviewHits },
      outcomes: {
        expected: expected.length,
        matched,
        done: all.filter((task) => task.state === "done").length,
        parked: all.filter((task) => task.state === "parked").length,
        handedOff: all.filter((task) => task.state === "inbox").length,
        unresolved: all.filter((task) => !TERMINAL.has(task.state)).length,
      },
      merges: world.merges.length,
      branches: world.branches.length,
      watchdogFires: all.filter(
        (task) => task.parkedReason?.includes("watchdog") ?? false,
      ).length,
      recoveries,
    },
    judgedMisses: misses,
    humanInterventions: [],
    notes,
  };
};
