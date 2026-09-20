/**
 * THE SCHEDULER'S SCORECARD — the WALK ranker (whole-board pick
 * walks + focused two-option gates, Scheduler.ts) judged against the
 * REAL System One API (gate.test.ts's pattern; gated on
 * `TYPESAFE_API_KEY`). The claims under test: context AFFINITY beats
 * FIFO on the judged rank; an urgent interrupt outranks adjacency;
 * the human's dragged order carries when signals are weak; and a
 * routine-looking card whose FULL body hides a prerequisite gets
 * DRILLED and ranked first. The deterministic edges (fallbacks, hint
 * math, deviation records, walk traces) live in ranking.test.ts; the
 * combinator itself in walk.test.ts.
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
import type { RankWrite, TaskRow } from "../../src/tasks/TasksDO.ts";

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
  const writes: Array<ReadonlyArray<RankWrite>> = [];
  const board: RankBoard = {
    list: (state) =>
      Effect.sync(() => (state === "ready" ? rows.slice() : [])),
    deskState: () =>
      Effect.sync(() => ({ working: [], width: 1, recent })),
    events: () => Effect.sync(() => []),
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

/** The misleading card: routine-looking title, a long body whose
 *  tail reveals the hard prerequisite — the walk's drill subject. */
const DRILL_BOARD: ReadonlyArray<CardSpec> = [
  {
    id: "t-bump",
    title: "chore(forge): bump the tree-walker dependency",
    // the clipped card reads as routine hygiene; only the FULL body
    // (past the 320-char clip) reveals the hard prerequisite
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
  },
  {
    id: "t-sidebar",
    title: "feat(forge): code browser sidebar",
    body: "Build the code browser's sidebar tree. High-visibility feature work on the forge UI.",
    tags: ["forge"],
  },
];

describe("the walk scheduler", () => {
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

  test.skipIf(!process.env.TYPESAFE_API_KEY)(
    "walk mechanics: NEXT stamped, traces persisted, ranks materialized",
    async () => {
      const input = boardOf(DRILL_BOARD);
      const entries = await runRank(input);
      // every ready row ranked, exactly one NEXT for the width-1 desk
      expect(entries.length).toBe(DRILL_BOARD.length);
      expect(
        entries.filter((entry) => entry.nextFor === "engineer").length,
      ).toBe(1);
      expect(entries[0]!.nextFor).toBe("engineer");
      // the pick's walk trace landed with the write
      const write = input.writes.at(-1)!;
      const top = write.find((entry) => entry.rank === 1)!;
      expect(top.trace).toBeDefined();
      expect(top.trace!.length).toBeGreaterThan(0);
      expect(top.trace![0]!.question).toContain("engineer");
      console.log(
        `walk ranked: ${entries
          .map((entry) => `${entry.id}#${entry.rank} (${entry.rankWhy})`)
          .join(" · ")} — trace ${top.trace!.length} step(s), drilled [${[
          ...new Set(
            write.flatMap((entry) =>
              (entry.trace ?? []).flatMap((step) => step.expanded),
            ),
          ),
        ].join(", ")}]`,
      );
    },
    { timeout: 90_000 },
  );
});
