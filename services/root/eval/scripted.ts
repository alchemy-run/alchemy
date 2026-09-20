/**
 * THE SCRIPTED RUNNER — drive one scenario through the desk world
 * (eval/world.ts, the same fixture desk-loop.test.ts asserts): desks
 * answer from the scenario's scripts, while the CONTROL PLANE is
 * judged by the REAL TypeSafe System One when the key is present —
 * the router's tag Choice per arrival, the scheduler's wide Choice
 * per claim, the forgotten-line disposition Choice, and the review
 * Noul. Without the key everything degrades to the scripted/FIFO
 * fallbacks and the judged metrics are skipped with a notice.
 */
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import { pump } from "../src/tasks/Desks.ts";
import { DEMANDS_CHANGES } from "../src/tasks/Review.ts";
import { routeTask } from "../src/tasks/Router.ts";
import { SURE } from "../src/tasks/Scheduler.ts";
import {
  confidenceOf,
  hasTypeSafeKey,
  noulOf,
  recordingQuery,
  type Exchange,
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

/** The choice criteria of one recorded wide-Choice ask, in card
 *  order — `none` first, then the board's ready order (FIFO). */
const candidatesOf = (exchange: Exchange): string[] => {
  const question = exchange.questions[exchange.kind];
  return question !== undefined &&
      question.type === "choice" &&
      question.criteria !== null &&
      typeof question.criteria === "object"
    ? Object.keys(question.criteria).filter((key) => key !== "none")
    : [];
};

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

  // ── the scheduler's asks, scored for affinity ────────────────────
  const schedulerAsks = (recorded?.exchanges ?? []).filter(
    (exchange) => exchange.kind === "next",
  );
  let applicable = 0;
  let affinityOptimal = 0;
  let signalStarved = 0;
  let askIndex = -1;
  for (const exchange of schedulerAsks) {
    askIndex += 1;
    const candidates = candidatesOf(exchange);
    // a `none` over actionable cards is its own miss — the loop
    // claims nothing and the board stalls with real work sitting ready
    {
      const confidence = confidenceOf(exchange, "next") ?? 0;
      if (
        candidates.length > 0 &&
        confidence >= SURE &&
        exchange.value.next === "none"
      ) {
        misses.push({
          edge: "scheduler",
          expected: `an actionable card (one of [${candidates.join(", ")}])`,
          got: "none",
          confidence,
          exchange,
        });
      }
    }
    if (candidates.length < 2) continue; // one card: no affinity choice
    const state = exchange.state as {
      desk?: { recent?: ReadonlyArray<{ tags?: ReadonlyArray<string> }> };
    };
    const recentTags = new Set(
      (state.desk?.recent ?? []).flatMap((entry) => entry.tags ?? []),
    );
    // starvation check: the desk HAD worked same-tag tasks before
    // this ask (the n-th ask follows n engineer claims), but the
    // state's `recent` carries none of their tags — the affinity
    // signal died upstream of the prompt
    const workedTags = new Set(
      world.dispatches
        .filter((entry) => entry.member === QUEUE.worker.slug)
        .slice(0, askIndex)
        .flatMap((entry) => world.task(entry.task).tags),
    );
    if (
      candidates.some((id) =>
        world.task(id).tags.some((tag) => workedTags.has(tag)),
      ) &&
      ![...workedTags].some((tag) => recentTags.has(tag))
    ) {
      signalStarved += 1;
    }
    const optimal = candidates.filter((id) =>
      world.task(id).tags.some((tag) => recentTags.has(tag)),
    );
    if (optimal.length === 0 || optimal.length === candidates.length) continue;
    applicable += 1;
    // the EFFECTIVE pick: below the bar the loop falls back to FIFO
    const confidence = confidenceOf(exchange, "next") ?? 0;
    const value = String(exchange.value.next ?? "");
    const effective = confidence >= SURE ? value : candidates[0]!;
    if (optimal.includes(effective)) {
      affinityOptimal += 1;
    } else {
      misses.push({
        edge: "scheduler",
        expected: `one of [${optimal.join(", ")}] (same-tag adjacency)`,
        got: effective === value ? value : `${value} → FIFO ${effective}`,
        confidence,
        exchange,
      });
    }
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
        asks: schedulerAsks.length,
        applicable,
        affinityOptimal,
        signalStarved,
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
