/**
 * THE SCHEDULER'S SCORECARD — the STAGED ranker (MAP urgency/fit
 * Scores, REDUCE pairwise Choices) judged against the REAL System
 * One API (gate.test.ts's pattern; gated on `TYPESAFE_API_KEY`).
 * The claims under test: context AFFINITY beats FIFO on the judged
 * rank; an urgent interrupt outranks adjacency; the human's dragged
 * order carries when signals are weak. The deterministic edges
 * (fallbacks, hint math, deviation records) live in ranking.test.ts.
 */
import * as TS from "@distilled.cloud/typesafe-ai";
import { RuntimeContext } from "alchemy";
import type * as TypeSafe from "alchemy/TypeSafe";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  rerank,
  type RankBoard,
  type RankEntry,
} from "../../src/tasks/Scheduler.ts";
import type {
  RankWrite,
  TaskRow,
  TaskScoreRow,
} from "../../src/tasks/TasksDO.ts";

const query = ((questions, options) =>
  TS.query(questions, options).pipe(
    Effect.provide([TS.CredentialsFromEnv, FetchHttpClient.layer]),
  )) as typeof TypeSafe.SystemOne.Service;

interface CardSpec {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags?: ReadonlyArray<string>;
  readonly priority?: number;
  readonly hint?: number;
}

/** A tiny in-memory RankBoard — ready rows + a desk's recent. */
const boardOf = (
  ready: ReadonlyArray<CardSpec>,
  recent: ReadonlyArray<{ title: string; tags: ReadonlyArray<string> }> = [],
) => {
  const rows: TaskRow[] = ready.map((card, index) => ({
    id: card.id,
    queue: "engineering",
    title: card.title,
    body: card.body,
    state: "ready",
    tags: card.tags ?? [],
    priority: card.priority ?? 2,
    workedBy: [],
    ...(card.hint === undefined ? {} : { hint: card.hint }),
    at: 1_000 + index,
    updated: 1_000 + index,
  }));
  const scoreRows: TaskScoreRow[] = [];
  const writes: Array<ReadonlyArray<RankWrite>> = [];
  const board: RankBoard = {
    list: () => Effect.sync(() => rows.slice()),
    deskState: () =>
      Effect.sync(() => ({ working: [], width: 1, recent })),
    scores: () => Effect.sync(() => scoreRows.slice()),
    writeScore: (id, hash, urgency, fit) =>
      Effect.sync(() => {
        const index = scoreRows.findIndex((row) => row.id === id);
        const next = { id, hash, urgency, fit, at: 0 };
        if (index >= 0) scoreRows[index] = next;
        else scoreRows.push(next);
      }),
    writeRanks: (entries) =>
      Effect.sync(() => {
        writes.push(entries);
      }),
  };
  return { board, writes };
};

const runRank = (
  input: ReturnType<typeof boardOf>,
): Promise<ReadonlyArray<RankEntry>> =>
  Effect.runPromise(
    rerank(query, input.board, "engineer").pipe(
      Effect.provide(RuntimeContext.phantom),
    ),
  );

interface Scenario {
  readonly name: string;
  readonly recent: ReadonlyArray<{
    title: string;
    tags: ReadonlyArray<string>;
  }>;
  readonly ready: ReadonlyArray<CardSpec>;
  /** Acceptable rank-1 ids. */
  readonly want: ReadonlyArray<string>;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    // the discovery that motivated desks: same recent focus wins
    // over the older unrelated task
    name: "R2-fresh desk ranks the R2 task over the older D1 one",
    recent: [
      { title: "fix(r2): bucket CORS rules drift on adopt", tags: ["cloudflare"] },
      {
        title: "feat(r2): event notifications on object create",
        tags: ["cloudflare"],
      },
    ],
    ready: [
      {
        id: "t-d1",
        title: "fix(d1): remote migration fails on uppercase BEGIN",
        body: "The remote D1 parser only accepts LF-only lowercase begin; our migration runner sends CRLF uppercase.",
        tags: ["cloudflare"],
      },
      {
        id: "t-r2",
        title: "fix(r2): multipart upload rejects part numbers over 1000",
        body: "R2 multipart uploads fail with InvalidPart when the part index exceeds 1000; the provider should chunk accordingly.",
        tags: ["cloudflare"],
      },
    ],
    want: ["t-r2"],
  },
  {
    name: "fly-fresh desk ranks the fly task over the older cloudflare one",
    recent: [
      { title: "fix(fly): machine restart loop on deploy", tags: ["fly"] },
      { title: "feat(fly): volume snapshot resource", tags: ["fly"] },
    ],
    ready: [
      {
        id: "t-cf",
        title: "fix(kv): list pagination cursor expires early",
        body: "KV list cursors return expired after 60s instead of the documented 5 minutes.",
        tags: ["cloudflare"],
      },
      {
        id: "t-fly",
        title: "fix(fly): blue/green promotes before health checks settle",
        body: "The deploy promotes the green machine set before every health check reports passing.",
        tags: ["fly"],
      },
    ],
    want: ["t-fly"],
  },
  {
    name: "an urgent outage outranks the adjacent routine task",
    recent: [
      { title: "fix(kv): metadata size limit off by one", tags: ["cloudflare"] },
    ],
    ready: [
      {
        id: "t-kv",
        title: "fix(kv): list pagination cursor expires early",
        body: "KV list cursors return expired after 60s instead of the documented 5 minutes. Routine, nothing blocked on it.",
        tags: ["cloudflare"],
        priority: 3,
      },
      {
        id: "t-outage",
        title: "fix(workers): deploys failing on main — every push red",
        body: "Every deploy of the worker fails at upload; the whole pipeline is blocked for everyone until this lands.",
        tags: ["cloudflare"],
        priority: 1,
      },
    ],
    want: ["t-outage"],
  },
  {
    // weak signals: the human's dragged order should carry — the
    // hinted card was dragged on top of the older sibling
    name: "weak signals follow the human's dragged order",
    recent: [],
    ready: [
      {
        id: "t-old",
        title: "chore(org): align the board's column paddings",
        body: "The parked column's cards sit 2px lower than ready's. Routine polish, nothing depends on it, no deadline.",
        tags: ["org"],
      },
      {
        id: "t-dragged",
        title: "chore(org): rename the queue switcher tooltip",
        body: "The switcher tooltip still says 'stream'; call it a queue. Routine, nothing depends on it, no deadline.",
        tags: ["org"],
        hint: 0,
      },
    ],
    want: ["t-dragged"],
  },
];

describe("the staged scheduler", () => {
  test("an empty board writes an empty rank", async () => {
    const input = boardOf([]);
    const entries = await runRank(input);
    expect(entries).toEqual([]);
    expect(input.writes).toEqual([[]]);
  });

  test.skipIf(!process.env.TYPESAFE_API_KEY)(
    "affinity beats FIFO; urgency interrupts; weak signals follow the drag",
    async () => {
      const results = await Promise.all(
        SCENARIOS.map(async (scenario) => {
          const entries = await runRank(
            boardOf(scenario.ready, scenario.recent),
          );
          const top = entries.find((entry) => entry.rank === 1);
          return {
            scenario,
            ok: top !== undefined && scenario.want.includes(top.id),
            got: entries
              .map((entry) => `${entry.id}#${entry.rank} (${entry.rankWhy})`)
              .join(" · "),
          };
        }),
      );
      const failures = results.filter((row) => !row.ok);
      for (const row of results) {
        console.log(
          `${row.ok ? "✓" : "✗"} ${row.scenario.name.padEnd(56)} ${row.got}` +
            (row.ok ? "" : `  wanted rank 1 ∈ ${row.scenario.want.join("|")}`),
        );
      }
      expect(failures.map((row) => row.scenario.name)).toEqual([]);
    },
    { timeout: 90_000 },
  );
});
