/**
 * THE LIVE RUNNER — one scenario against the REAL stack (`bun run
 * dev`: UI :1337, worker :1340). It reuses a running stack (spawning
 * one only if nothing answers; it NEVER wipes state), dials the desk
 * width, files the arrivals on schedule (bodies carry an
 * `[eval:<runId>]` marker; no explicit tags, so the live router runs
 * for real), then OBSERVES the board until every filed task settles
 * or the deadline lands. Human-in-the-loop is a feature: `--ui` opens
 * the board in the browser and the runner streams a status line while
 * the human watches, clicks and moves tasks — human moves are scored
 * as `humanInterventions`, never failures.
 *
 * Live scoring is honest about reach: routing accuracy (router tag vs
 * ground truth), disposition outcomes, durations, recoveries and
 * watchdog fires, and clone-session claims (the width>1 fork proxy)
 * are scored; the scheduler's and judges' inner exchanges happen
 * server-side and are recorded descriptively instead.
 */
import * as path from "node:path";
import {
  confusionOf,
  type HumanIntervention,
  type ScenarioReport,
  type TaskReport,
} from "./report.ts";
import {
  stateOfDisposition,
  truthTagOf,
  type Arrival,
  type Scenario,
} from "./scenario.ts";

const API = process.env.EVAL_API_URL ?? "http://localhost:1340";
const UI = process.env.EVAL_UI_URL ?? "http://localhost:1337";
const QUEUE_SLUG = "engineering";
const WORKER_DESK = "engineer";
const HUMAN = "sam";
const POLL_MS = 5_000;
const STALL_MS = 120_000;

interface WireTask {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly tags: ReadonlyArray<string>;
  readonly at: number;
  readonly updated: number;
  readonly parkedReason?: string;
}

interface WireEvent {
  readonly kind: string;
  readonly actor: string;
  readonly data?: string;
  readonly at: number;
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const get = async <T>(route: string): Promise<T> => {
  const response = await fetch(`${API}${route}`);
  if (!response.ok) throw new Error(`GET ${route} → ${response.status}`);
  return (await response.json()) as T;
};

const post = async <T>(route: string, body: unknown): Promise<T> => {
  const response = await fetch(`${API}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${route} → ${response.status}`);
  return (await response.json()) as T;
};

const probe = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${API}/api/tasks/queues`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

/** Reuse a running stack; spawn `bun run dev` only when nothing
 *  answers. Never touches existing state either way. */
const ensureStack = async (): Promise<void> => {
  if (await probe()) return;
  console.log(`no stack at ${API} — spawning \`bun run dev\` (this can take a while)`);
  const token =
    process.env.GITHUB_TOKEN ??
    new TextDecoder()
      .decode(Bun.spawnSync(["gh", "auth", "token"]).stdout)
      .trim();
  const child = Bun.spawn(["bun", "run", "dev"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, GITHUB_TOKEN: token },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(3_000);
    if (await probe()) return;
  }
  throw new Error(`dev stack did not answer at ${API} within 180s`);
};

interface QueuesView {
  readonly queues: ReadonlyArray<{
    readonly slug: string;
    readonly desks: ReadonlyArray<{
      readonly slug: string;
      readonly width: number;
      readonly working: ReadonlyArray<{ readonly id: string }>;
    }>;
  }>;
}

const deskWidth = async (): Promise<number> => {
  const view = await get<QueuesView>("/api/tasks/queues");
  return (
    view.queues
      .find((queue) => queue.slug === QUEUE_SLUG)
      ?.desks.find((desk) => desk.slug === WORKER_DESK)?.width ?? 1
  );
};

export interface LiveOptions {
  readonly ui?: boolean;
  /** Score ONLY this run's tasks (always true in effect — the run
   *  filters to its own filed ids); noted in the report. */
  readonly freshBoard?: boolean;
  readonly cap?: number;
  readonly width?: number;
}

export const runLive = async (
  scenario: Scenario,
  options: LiveOptions = {},
): Promise<ScenarioReport> => {
  const startedAt = new Date().toISOString();
  const startMs = performance.now();
  const runId = `live-${startedAt.replaceAll(/[:.]/g, "-")}`;
  const notes: string[] = [];

  await ensureStack();

  // pre-existing READY work shares the scheduler with this run
  const board = await get<{ tasks: Record<string, WireTask[]> }>(
    `/api/tasks/${QUEUE_SLUG}`,
  );
  const preExisting =
    (board.tasks.ready?.length ?? 0) + (board.tasks.working?.length ?? 0);
  if (preExisting > 0) {
    notes.push(
      `${preExisting} pre-existing ready/working tasks share the desks with this run${
        options.freshBoard === true ? " (scored ids are this run's only)" : ""
      }`,
    );
  }

  // dial the width for the scenario; restore afterwards
  const width = options.width ?? scenario.width;
  const priorWidth = await deskWidth();
  if (width !== undefined && width !== priorWidth) {
    await post(`/api/tasks/${QUEUE_SLUG}/desks/${WORKER_DESK}/width`, {
      width,
    });
    notes.push(`engineer width dialed ${priorWidth} → ${width} for the run`);
  }

  if (options.ui === true) {
    Bun.spawn(["open", `${UI}/tasks/${QUEUE_SLUG}`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (scenario.interactions !== undefined) {
      console.log("while you watch:");
      for (const line of scenario.interactions) console.log(`  · ${line}`);
    }
  }

  // ── file the arrivals on schedule (no tags — the router runs) ────
  const arrivals = [...scenario.arrivals]
    .sort((a, b) => a.afterMs - b.afterMs)
    .slice(0, options.cap ?? scenario.arrivals.length);
  const filed: Array<{ arrival: Arrival; id: string }> = [];
  let elapsed = 0;
  for (const arrival of arrivals) {
    if (arrival.afterMs > elapsed) {
      await sleep(arrival.afterMs - elapsed);
      elapsed = arrival.afterMs;
    }
    const { task } = await post<{ task: WireTask }>("/api/tasks", {
      title: arrival.title,
      body: `${arrival.body}\n\n[eval:${runId}]`,
    });
    filed.push({ arrival, id: task.id });
    console.log(
      `filed ${task.id} [${task.tags.join(",") || "untagged"} → ${task.state}] ${arrival.title.slice(0, 64)}`,
    );
  }
  const ours = new Set(filed.map((entry) => entry.id));

  // ── observe until settled, stalled, or the deadline ──────────────
  const deadline = startMs + (scenario.deadlineMs ?? 600_000);
  const started = new Set<string>();
  let lastSignature = "";
  let lastChangeMs = performance.now();
  const tty = process.stdout.isTTY === true;
  let lastPrintMs = 0;
  const terminal = (task: WireTask): boolean =>
    task.state === "done" ||
    task.state === "parked" ||
    task.state === "dropped" ||
    // a handoff lands back in the inbox after having been worked
    (task.state === "inbox" && started.has(task.id));
  for (;;) {
    const view = await get<{ tasks: Record<string, WireTask[]> }>(
      `/api/tasks/${QUEUE_SLUG}`,
    );
    const rows = Object.values(view.tasks)
      .flat()
      .filter((task) => ours.has(task.id));
    for (const row of rows) {
      if (row.state === "working" || row.state === "review") {
        started.add(row.id);
      }
    }
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
    }
    const queues = await get<QueuesView>("/api/tasks/queues");
    const working = queues.queues
      .find((queue) => queue.slug === QUEUE_SLUG)
      ?.desks.flatMap((desk) =>
        desk.working.map((task) => `${desk.slug}:${task.id}`),
      ) ?? [];
    const seconds = Math.round((performance.now() - startMs) / 1000);
    const line =
      `[${scenario.name}] ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")} ` +
      [...counts.entries()].map(([state, n]) => `${state} ${n}`).join(" · ") +
      (working.length === 0 ? " · desks idle" : ` · ${working.join(", ")}`);
    if (tty) {
      process.stdout.write(`\r${line.padEnd(110)}`);
    } else if (performance.now() - lastPrintMs > 30_000) {
      console.log(line);
      lastPrintMs = performance.now();
    }
    const signature = rows
      .map((row) => `${row.id}:${row.state}:${row.updated}`)
      .join(",");
    if (signature !== lastSignature || working.length > 0) {
      // desks grinding ANY work (ours or a pre-existing backlog) is
      // not a stall — only an idle board with unmoved tasks is
      lastSignature = signature;
      lastChangeMs = performance.now();
    }
    if (rows.length === filed.length && rows.every(terminal)) break;
    if (performance.now() > deadline) {
      notes.push("deadline reached with unresolved tasks");
      break;
    }
    if (performance.now() - lastChangeMs > STALL_MS) {
      notes.push(
        `no board movement for ${Math.round(STALL_MS / 1000)}s with desks idle — finishing with what settled` +
          (started.size === 0 && rows.some((row) => row.state === "ready")
            ? " (ready work never claimed — the queue's 20/hour dispatch budget is likely spent)"
            : ""),
      );
      break;
    }
    await sleep(POLL_MS);
  }
  if (tty) process.stdout.write("\n");

  if (width !== undefined && width !== priorWidth) {
    await post(`/api/tasks/${QUEUE_SLUG}/desks/${WORKER_DESK}/width`, {
      width: priorWidth,
    });
  }

  // ── score what's scorable live ───────────────────────────────────
  const routingPairs: Array<{ chose: string; truth: string }> = [];
  const tasks: TaskReport[] = [];
  const interventions: HumanIntervention[] = [];
  let recoveries = 0;
  let watchdogFires = 0;
  let cloneClaims = 0;
  let bounces = 0;
  for (const entry of filed) {
    const { task, events } = await get<{
      task: WireTask;
      events: ReadonlyArray<WireEvent>;
    }>(`/api/tasks/${QUEUE_SLUG}/${entry.id}`);
    // the router's pick as FILED (a later human retag is a move, not
    // the router's answer)
    const filedEvent = events.find((event) => event.kind === "filed");
    let routedTag = "untagged";
    try {
      const data = JSON.parse(filedEvent?.data ?? "{}") as {
        tags?: string[];
      };
      routedTag = data.tags?.[0] ?? "untagged";
    } catch {
      /* unparsable filed data reads as untagged */
    }
    routingPairs.push({ chose: routedTag, truth: truthTagOf(entry.arrival) });
    const rounds = events.filter((event) => {
      if (event.kind !== "assigned") return false;
      try {
        const data = JSON.parse(event.data ?? "{}") as {
          desk?: string;
          session?: string;
        };
        if (data.session?.includes("#") ?? false) cloneClaims += 1;
        return data.desk === WORKER_DESK;
      } catch {
        return false;
      }
    }).length;
    recoveries += events.filter(
      (event) => event.data?.startsWith("recovered:") ?? false,
    ).length;
    watchdogFires += events.filter(
      (event) => event.actor === "watchdog",
    ).length;
    bounces += events.filter(
      (event) => event.kind === "changes_requested",
    ).length;
    for (const event of events) {
      if (event.actor === HUMAN && event.kind !== "filed") {
        interventions.push({
          task: entry.id,
          kind: event.kind,
          ...(event.data === undefined ? {} : { data: event.data }),
          at: event.at,
        });
      }
    }
    tasks.push({
      id: entry.id,
      title: entry.arrival.title,
      truthTag: truthTagOf(entry.arrival),
      routedTag,
      ...(entry.arrival.expect.disposition === undefined
        ? {}
        : { expectedDisposition: entry.arrival.expect.disposition }),
      finalState: task.state,
      rounds,
      ...(entry.arrival.expect.maxRounds === undefined
        ? {}
        : { maxRounds: entry.arrival.expect.maxRounds }),
      durationMs: task.updated - task.at,
      ...(task.parkedReason === undefined
        ? {}
        : { parkedReason: task.parkedReason }),
    });
  }
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
  notes.push(
    "live mode: scheduler/disposition/review exchanges run server-side and are not directly scorable; " +
      `observed ${bounces} review bounce(s), ${cloneClaims} clone-session claim(s)`,
  );

  return {
    runId,
    scenario: scenario.name,
    mode: "live",
    judged: false,
    startedAt,
    wallMs: Math.round(performance.now() - startMs),
    tasks,
    metrics: {
      routing: {
        total: routingPairs.length,
        hits: routingPairs.filter((pair) => pair.chose === pair.truth).length,
        confusion: confusionOf(routingPairs),
      },
      scheduler: {
        asks: 0,
        applicable: 0,
        affinityOptimal: 0,
        signalStarved: 0,
      },
      disposition: { total: 0, hits: 0 },
      review: { total: 0, hits: 0 },
      outcomes: {
        expected: expected.length,
        matched,
        done: tasks.filter((task) => task.finalState === "done").length,
        parked: tasks.filter((task) => task.finalState === "parked").length,
        handedOff: tasks.filter(
          (task) => task.finalState === "inbox" && task.rounds > 0,
        ).length,
        unresolved: tasks.filter(
          (task) =>
            !["done", "parked", "dropped"].includes(task.finalState) &&
            !(task.finalState === "inbox" && task.rounds > 0),
        ).length,
      },
      merges: cloneClaims,
      branches: cloneClaims,
      watchdogFires,
      recoveries,
    },
    judgedMisses: [],
    humanInterventions: interventions,
    notes,
  };
};
