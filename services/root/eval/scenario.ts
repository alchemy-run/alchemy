/**
 * THE SCENARIO SCHEMA — one eval scenario is a stream of task
 * ARRIVALS with ground truth attached: the area tag the router should
 * pick, the disposition the desk should land, and (scripted mode
 * only) the desk replies each round should produce. The runners
 * (scripted.ts, live.ts) drive the same scenario against the
 * in-memory world or the real stack and score the control plane —
 * router tag choice, scheduler affinity, disposition parsing/judging,
 * review verdicts — against this ground truth.
 */

export type DispositionKind = "complete" | "park" | "handoff";

/** Ground truth for one judged edge — a review Noul's verdict or a
 *  forgotten-line disposition Choice's answer. */
export type RoundExpectation =
  | "approved"
  | "changes_requested"
  | DispositionKind;

/** One scripted desk round for a task (scripted mode; live desks are
 *  real agents and script nothing). Rounds are consumed per task in
 *  order, per member — claim ORDER stays the judged scheduler's. */
export interface ScriptedRound {
  readonly member: "engineer" | "reviewer";
  /** The reply the desk session answers with. A worker reply that
   *  omits its DISPOSITION line exercises the judged fallback. */
  readonly reply: string;
  /** What the judged edge should decide about this reply — scored as
   *  judge agreement when the real System One is doing the judging. */
  readonly expect?: RoundExpectation;
}

export interface Arrival {
  /** When the task is filed, relative to the scenario's start. The
   *  scripted runner uses the ORDER only; the live runner sleeps. */
  readonly afterMs: number;
  readonly title: string;
  readonly body: string;
  /** The HUMAN's dragged position among ready siblings (1 = top).
   *  The scripted runner replays the drags (one reorder per hinted
   *  arrival) after filing — the soft ranking signal under test. */
  readonly humanRank?: number;
  /** Ground truth AREA tags — tags[0] is what the router should
   *  choose (Tags.ts rubrics). Omit when no area clearly owns it. */
  readonly tags?: ReadonlyArray<string>;
  readonly expect: {
    /** The router's expected pick; `"untagged"` when staying in the
     *  inbox for a human IS the right answer. Defaults to tags[0]. */
    readonly tag?: string;
    /** The disposition the work should land: complete → done (via
     *  review), park → parked, handoff → inbox. */
    readonly disposition?: DispositionKind;
    /** Ceiling on worker rounds (a bounce counts one more round). */
    readonly maxRounds?: number;
  };
  readonly rounds?: ReadonlyArray<ScriptedRound>;
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  /** The engineer desk's width for this scenario (default 1). */
  readonly width?: number;
  readonly arrivals: ReadonlyArray<Arrival>;
  /** Ground-truth OPTIMAL claim order, as 1-based arrival indices —
   *  scored against the engineer desk's actual claim order (judged
   *  runs only; the unjudged fallback is hint-then-FIFO by design). */
  readonly truthOrder?: ReadonlyArray<number>;
  /** True when reaching the truth order REQUIRES the judge to
   *  deviate from the human's dragged order (the prerequisite case)
   *  — scored as a miss if no deviation was recorded. */
  readonly expectsDeviation?: boolean;
  /** True when same-tag CHAINING is this scenario's subject: a
   *  non-adjacent claim becomes a judged miss. Other scenarios still
   *  report the affinity ratio, informationally. */
  readonly affinity?: boolean;
  /** Walk-quality ground truth (scenarios/walk.ts). `shouldDrill`
   *  names the arrivals (1-based indices) whose HIDDEN content the
   *  walk should open before ranking; `forbidDrill` claims the
   *  visible cards suffice — any drill is a judged miss. Drill
   *  precision/recall are reported either way. */
  readonly walk?: {
    readonly shouldDrill?: ReadonlyArray<number>;
    readonly forbidDrill?: boolean;
  };
  /** Notes for the human watching/steering a live run (`--ui`). */
  readonly interactions?: ReadonlyArray<string>;
  /** Live-mode observation deadline (default 10 minutes). */
  readonly deadlineMs?: number;
}

/** The routing truth for one arrival: expect.tag, else tags[0], else
 *  `untagged` (no area owns it — inbox is correct). */
export const truthTagOf = (arrival: Arrival): string =>
  arrival.expect.tag ?? arrival.tags?.[0] ?? "untagged";

/** The terminal state one expected disposition lands in. */
export const stateOfDisposition = (
  disposition: DispositionKind,
): "done" | "parked" | "inbox" =>
  disposition === "complete"
    ? "done"
    : disposition === "park"
      ? "parked"
      : "inbox";
