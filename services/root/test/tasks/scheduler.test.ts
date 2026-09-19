/**
 * THE SCHEDULER'S SCORECARD — judged against the REAL System One API
 * (gate.test.ts's pattern; gated on `TYPESAFE_API_KEY`). The claim
 * under test: context AFFINITY beats FIFO — an idle desk with recent
 * focus picks the adjacent task, not the oldest — and `none` wins on
 * an empty or unworthy board.
 */
import * as TS from "@distilled.cloud/typesafe-ai";
import { RuntimeContext } from "alchemy";
import type * as TypeSafe from "alchemy/TypeSafe";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  nextTask,
  type DeskSnapshot,
  type TaskCard,
} from "../../src/tasks/Scheduler.ts";

const query = ((questions, options) =>
  TS.query(questions, options).pipe(
    Effect.provide([TS.CredentialsFromEnv, FetchHttpClient.layer]),
  )) as typeof TypeSafe.SystemOne.Service;

const card = (
  id: string,
  title: string,
  body: string,
  priority = 2,
): TaskCard => ({ id, title, body, priority });

interface Scenario {
  readonly name: string;
  readonly desk: DeskSnapshot;
  /** Board order — priority then age; `ready[0]` is the FIFO pick. */
  readonly ready: ReadonlyArray<TaskCard>;
  /** Acceptable picks (`undefined` = none). */
  readonly want: ReadonlyArray<string | undefined>;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    // the discovery that motivated desks: same provider area wins
    // over the older unrelated task
    name: "R2 desk picks the R2 task over the older D1 one",
    desk: {
      desk: "engineer",
      recent: [
        "fix(r2): bucket CORS rules drift on adopt",
        "feat(r2): event notifications on object create",
      ],
    },
    ready: [
      card(
        "t-d1",
        "fix(d1): remote migration fails on uppercase BEGIN",
        "The remote D1 parser only accepts LF-only lowercase begin; our migration runner sends CRLF uppercase.",
      ),
      card(
        "t-r2",
        "fix(r2): multipart upload rejects part numbers over 1000",
        "R2 multipart uploads fail with InvalidPart when the part index exceeds 1000; the provider should chunk accordingly.",
      ),
    ],
    want: ["t-r2"],
  },
  {
    name: "DO desk picks the DO alarm task over the older queues one",
    desk: {
      desk: "engineer",
      recent: [
        "fix(do): websocket hibernation drops attachments",
        "fix(do): storage transaction retries on conflict",
      ],
    },
    ready: [
      card(
        "t-queues",
        "feat(queues): consumer batch size configuration",
        "Expose max_batch_size and max_batch_timeout on the queue consumer binding.",
      ),
      card(
        "t-alarms",
        "fix(do): alarms are not re-registered after eviction",
        "A Durable Object that set an alarm loses it when evicted mid-window; the constructor must re-register.",
      ),
    ],
    want: ["t-alarms"],
  },
  {
    name: "an urgent priority-1 task outranks the adjacent priority-3",
    desk: {
      desk: "engineer",
      recent: ["fix(kv): metadata size limit off by one"],
    },
    ready: [
      card(
        "t-outage",
        "fix(workers): deploys failing on main — every push red",
        "Every deploy of the worker fails at upload; the whole pipeline is blocked for everyone.",
        1,
      ),
      card(
        "t-kv",
        "fix(kv): list pagination cursor expires early",
        "KV list cursors return expired after 60s instead of the documented 5 minutes.",
        3,
      ),
    ],
    want: ["t-outage"],
  },
  {
    name: "a cold desk with no recent focus still starts real work",
    desk: { desk: "engineer", recent: [] },
    ready: [
      card(
        "t-a",
        "fix(r2): bucket lifecycle rules ignored on update",
        "Updating lifecycle rules on an existing bucket silently no-ops.",
      ),
      card(
        "t-b",
        "fix(d1): migration runner drops comments",
        "SQL comments in migration files are stripped, breaking checksum verification.",
      ),
    ],
    // either real task is a fine pick — the assertion is: not none
    want: ["t-a", "t-b"],
  },
  {
    name: "an unworthy board picks none",
    desk: {
      desk: "engineer",
      recent: ["fix(r2): bucket CORS rules drift on adopt"],
    },
    ready: [
      card(
        "t-fyi",
        "FYI: deploy config drift was already fixed",
        "Nothing to do — the drift was corrected by hand this morning; this card is informational only, no action needed or wanted.",
      ),
    ],
    want: [undefined],
  },
];

describe("the scheduler", () => {
  test("empty board needs no judgment", async () => {
    const picked = await Effect.runPromise(
      nextTask(query, { desk: "engineer", recent: [] }, []).pipe(
        Effect.provide(RuntimeContext.phantom),
      ),
    );
    expect(picked).toBeUndefined();
  });

  test.skipIf(!process.env.TYPESAFE_API_KEY)(
    "affinity beats FIFO; none on unworthy boards",
    async () => {
      const results = await Effect.runPromise(
        Effect.forEach(
          SCENARIOS,
          Effect.fn(function* (scenario: Scenario) {
            const picked = yield* nextTask(
              query,
              scenario.desk,
              scenario.ready,
            );
            return {
              scenario,
              ok: scenario.want.includes(picked),
              got: picked ?? "none",
            };
          }),
          { concurrency: 3 },
        ).pipe(Effect.provide(RuntimeContext.phantom)),
      );
      const failures = results.filter((row) => !row.ok);
      for (const row of results) {
        console.log(
          `${row.ok ? "✓" : "✗"} ${row.scenario.name.padEnd(56)} ${row.got}` +
            (row.ok
              ? ""
              : `  wanted ${row.scenario.want.map((want) => want ?? "none").join("|")}`),
        );
      }
      expect(failures.map((row) => row.scenario.name)).toEqual([]);
    },
    { timeout: 90_000 },
  );
});
