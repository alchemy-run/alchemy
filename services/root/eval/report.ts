/**
 * THE REPORT — one JSON document per scenario run, plus the compact
 * terminal table. A judged MISS carries its full System One exchange
 * (the rubric cards + state it saw, the answer + calibration it gave,
 * and what the ground truth wanted) so a miss points straight at the
 * rubric/prompt to tweak. Per-tag confusion is aggregated across the
 * routing misses for the same reason.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Exchange } from "./judge.ts";

export interface TaskReport {
  readonly id: string;
  readonly title: string;
  readonly truthTag: string;
  /** What the router chose (`untagged` = stayed in the inbox). */
  readonly routedTag?: string;
  readonly expectedDisposition?: string;
  readonly finalState: string;
  /** Worker rounds the task consumed (a bounce adds one). */
  readonly rounds: number;
  readonly maxRounds?: number;
  readonly durationMs?: number;
  readonly parkedReason?: string;
}

/** One judged miss with everything needed to tune the prompt. */
export interface JudgedMiss {
  /** `routing` | `scheduler` | `ranking` | `disposition` | `review` */
  readonly edge: string;
  readonly task?: string;
  readonly expected: string;
  readonly got: string;
  readonly confidence?: number;
  /** The FULL exchange: rubric cards + state + answer + calibration.
   *  Absent for code-level misses (claim-order, starvation). */
  readonly exchange?: Exchange;
}

export interface Confusion {
  readonly chose: string;
  readonly truth: string;
  readonly n: number;
}

export interface Ratio {
  readonly total: number;
  readonly hits: number;
}

export interface Metrics {
  readonly routing: Ratio & { readonly confusion: ReadonlyArray<Confusion> };
  readonly scheduler: {
    readonly asks: number;
    /** Asks where a ready candidate shared a tag with recent work. */
    readonly applicable: number;
    readonly affinityOptimal: number;
    /** Asks where the desk HAD completed same-tag work but the
     *  state's `recent` showed none — the affinity signal starved
     *  upstream of the prompt (review claims re-desk the task). */
    readonly signalStarved: number;
  };
  readonly disposition: Ratio;
  readonly review: Ratio;
  /** The walk ranker (Scheduler.ts): pick-walk calls, two-option
   *  gates/compares, the deviations it took against the human's
   *  dragged order (with their why lines), the drills it made vs the
   *  scenario's drill truth, rank CHURN across re-ranks (position
   *  changes without a justifying event — informational, always-
   *  fresh re-ranking must move for a reason), and — when the
   *  scenario declares a `truthOrder` — claim order vs truth. */
  readonly ranking?: {
    /** Pick-walk fan-out calls (`next`+`probe`). */
    readonly walks: number;
    /** Focused two-option calls (deviation gates, compares). */
    readonly pairs: number;
    readonly deviations: number;
    readonly deviationWhys: ReadonlyArray<string>;
    readonly drill?: {
      readonly drilled: ReadonlyArray<string>;
      readonly truth?: ReadonlyArray<string>;
      readonly precision?: number;
      readonly recall?: number;
    };
    readonly churn?: {
      /** Consecutive re-rank pairs compared. */
      readonly transitions: number;
      /** Relative-order flips among tasks present in both ranks. */
      readonly movedPairs: number;
      /** Flips where NO event between the ranks touched either
       *  task — movement without a visible cause. */
      readonly unjustifiedPairs: number;
    };
    readonly order?: {
      readonly truth: ReadonlyArray<string>;
      readonly claimed: ReadonlyArray<string>;
      readonly matched: boolean;
    };
  };
  readonly outcomes: {
    readonly expected: number;
    readonly matched: number;
    readonly done: number;
    readonly parked: number;
    readonly handedOff: number;
    readonly unresolved: number;
  };
  readonly merges: number;
  readonly branches: number;
  readonly watchdogFires: number;
  readonly recoveries: number;
}

export interface HumanIntervention {
  readonly task: string;
  readonly kind: string;
  readonly data?: string;
  readonly at: number;
}

export interface ScenarioReport {
  readonly runId: string;
  readonly scenario: string;
  readonly mode: "scripted" | "live";
  /** Whether the real System One judged the control plane. */
  readonly judged: boolean;
  readonly startedAt: string;
  readonly wallMs: number;
  readonly tasks: ReadonlyArray<TaskReport>;
  readonly metrics: Metrics;
  readonly judgedMisses: ReadonlyArray<JudgedMiss>;
  readonly humanInterventions: ReadonlyArray<HumanIntervention>;
  readonly notes: ReadonlyArray<string>;
}

const REPORTS_DIR = path.join(import.meta.dir, "reports");

/** Write the report under eval/reports/, answering its path. */
export const writeReport = (report: ScenarioReport): string => {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = report.startedAt.replaceAll(/[:.]/g, "-");
  const file = path.join(REPORTS_DIR, `${stamp}-${report.scenario}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
};

const pct = (ratio: Ratio): string =>
  ratio.total === 0
    ? "—"
    : `${ratio.hits}/${ratio.total} (${((ratio.hits / ratio.total) * 100).toFixed(0)}%)`;

/** The compact terminal table for one scenario run. */
export const printReport = (report: ScenarioReport, file?: string): void => {
  const m = report.metrics;
  const seconds = (report.wallMs / 1000).toFixed(1);
  const mode =
    report.mode === "live"
      ? "live"
      : report.judged
        ? "scripted, judged"
        : "scripted, UNJUDGED — no TYPESAFE_API_KEY";
  console.log(`\n━━ ${report.scenario} (${mode}) · ${seconds}s`);
  console.log(`   routing      ${pct(m.routing)}`);
  console.log(
    `   scheduler    ${
      m.scheduler.applicable === 0
        ? `${m.scheduler.asks} asks, affinity n/a`
        : `${m.scheduler.affinityOptimal}/${m.scheduler.applicable} affinity-optimal (${m.scheduler.asks} asks)`
    }${m.scheduler.signalStarved > 0 ? ` · SIGNAL STARVED ×${m.scheduler.signalStarved}` : ""}`,
  );
  console.log(`   disposition  ${pct(m.disposition)} judge agreement`);
  console.log(`   review       ${pct(m.review)} noul agreement`);
  if (m.ranking !== undefined) {
    console.log(
      `   ranking      ${m.ranking.walks} walk calls · ${m.ranking.pairs} pairwise · ${m.ranking.deviations} deviation(s)` +
        (m.ranking.order === undefined
          ? ""
          : ` · order ${m.ranking.order.matched ? "✓" : "✗"} claimed [${m.ranking.order.claimed.join(" ")}] truth [${m.ranking.order.truth.join(" ")}]`),
    );
    if (m.ranking.drill !== undefined) {
      const drill = m.ranking.drill;
      console.log(
        `   drill        [${drill.drilled.join(" ")}]` +
          (drill.truth === undefined
            ? ""
            : ` truth [${drill.truth.join(" ")}]`) +
          (drill.precision === undefined
            ? ""
            : ` · precision ${(drill.precision * 100).toFixed(0)}%`) +
          (drill.recall === undefined
            ? ""
            : ` · recall ${(drill.recall * 100).toFixed(0)}%`),
      );
    }
    if (m.ranking.churn !== undefined && m.ranking.churn.transitions > 0) {
      console.log(
        `   churn        ${m.ranking.churn.movedPairs} moved pair(s) over ${m.ranking.churn.transitions} re-rank(s) · ${m.ranking.churn.unjustifiedPairs} unjustified`,
      );
    }
    for (const why of m.ranking.deviationWhys) {
      console.log(`   deviation    ${why}`);
    }
  }
  console.log(
    `   outcomes     ${m.outcomes.matched}/${m.outcomes.expected} expected · done ${m.outcomes.done} · parked ${m.outcomes.parked} · handoff ${m.outcomes.handedOff} · unresolved ${m.outcomes.unresolved}`,
  );
  console.log(
    `   fork/merge   ${m.branches} forked, ${m.merges} merged · watchdog ${m.watchdogFires} · recoveries ${m.recoveries}`,
  );
  for (const row of m.routing.confusion) {
    console.log(`   confusion    chose ${row.chose}, truth ${row.truth} ×${row.n}`);
  }
  if (report.humanInterventions.length > 0) {
    console.log(`   human moves  ${report.humanInterventions.length}`);
  }
  for (const task of report.tasks) {
    const routed =
      task.routedTag === undefined
        ? ""
        : ` [${task.truthTag}→${task.routedTag}${task.routedTag === task.truthTag ? "" : " ✗"}]`;
    const outcome =
      task.expectedDisposition === undefined
        ? task.finalState
        : `${task.finalState}${
            matchesExpectation(task) ? "" : ` ✗ wanted ${task.expectedDisposition}`
          }`;
    const rounds = task.rounds === 1 ? "1 round" : `${task.rounds} rounds`;
    const over =
      task.maxRounds !== undefined && task.rounds > task.maxRounds
        ? ` (over max ${task.maxRounds})`
        : "";
    console.log(
      `    ${matchesExpectation(task) && (task.routedTag === undefined || task.routedTag === task.truthTag) ? "✓" : "✗"} ${task.id} ${task.title.slice(0, 56).padEnd(56)}${routed} ${outcome} · ${rounds}${over}`,
    );
  }
  for (const miss of report.judgedMisses) {
    console.log(
      `   MISS ${miss.edge}${miss.task === undefined ? "" : ` (${miss.task})`}: wanted ${miss.expected}, got ${miss.got}${
        miss.confidence === undefined ? "" : ` @ ${miss.confidence.toFixed(2)}`
      }`,
    );
  }
  for (const note of report.notes) console.log(`   note: ${note}`);
  if (file !== undefined) console.log(`   report → ${path.relative(process.cwd(), file)}`);
};

/** Whether one task's final state matches its expected disposition. */
export const matchesExpectation = (task: TaskReport): boolean => {
  if (task.expectedDisposition === undefined) return true;
  const wanted =
    task.expectedDisposition === "complete"
      ? "done"
      : task.expectedDisposition === "park"
        ? "parked"
        : "inbox";
  return task.finalState === wanted;
};

/** Aggregate a confusion table out of (chose, truth) pairs. */
export const confusionOf = (
  pairs: ReadonlyArray<{ chose: string; truth: string }>,
): Confusion[] => {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    if (pair.chose === pair.truth) continue;
    const key = `${pair.chose}\u0000${pair.truth}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, n]) => {
    const [chose, truth] = key.split("\u0000") as [string, string];
    return { chose, truth, n };
  });
};
