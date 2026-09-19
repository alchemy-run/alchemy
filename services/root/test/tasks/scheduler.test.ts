/**
 * THE SCHEDULER'S SCORECARD — judged against the REAL System One API
 * (gate.test.ts's pattern; gated on `TYPESAFE_API_KEY`). The claim
 * under test: context AFFINITY beats FIFO — an idle desk with recent
 * focus picks the adjacent task (same TAG first), not the oldest —
 * and `none` wins on an empty or unworthy board.
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
  tags: ReadonlyArray<string> = [],
  priority = 2,
): TaskCard => ({ id, title, body, tags, priority });

/** A desk's recent entry — title + the tags it wore. */
const worked = (
  title: string,
  ...tags: ReadonlyArray<string>
): { title: string; tags: ReadonlyArray<string> } => ({ title, tags });

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
        worked("fix(r2): bucket CORS rules drift on adopt", "cloudflare"),
        worked(
          "feat(r2): event notifications on object create",
          "cloudflare",
        ),
      ],
    },
    ready: [
      card(
        "t-d1",
        "fix(d1): remote migration fails on uppercase BEGIN",
        "The remote D1 parser only accepts LF-only lowercase begin; our migration runner sends CRLF uppercase.",
        ["cloudflare"],
      ),
      card(
        "t-r2",
        "fix(r2): multipart upload rejects part numbers over 1000",
        "R2 multipart uploads fail with InvalidPart when the part index exceeds 1000; the provider should chunk accordingly.",
        ["cloudflare"],
      ),
    ],
    want: ["t-r2"],
  },
  {
    // TAG affinity on the one queue: the fly-fresh desk stays on the
    // fly-tagged task even though the cloudflare one is older
    name: "fly-fresh desk picks the fly task over the older cloudflare one",
    desk: {
      desk: "engineer",
      recent: [
        worked("fix(fly): machine restart loop on deploy", "fly"),
        worked("feat(fly): volume snapshot resource", "fly"),
      ],
    },
    ready: [
      card(
        "t-cf",
        "fix(kv): list pagination cursor expires early",
        "KV list cursors return expired after 60s instead of the documented 5 minutes.",
        ["cloudflare"],
      ),
      card(
        "t-fly",
        "fix(fly): blue/green promotes before health checks settle",
        "The deploy promotes the green machine set before every health check reports passing.",
        ["fly"],
      ),
    ],
    want: ["t-fly"],
  },
  {
    // and the mirror: a cloudflare-fresh desk stays on cloudflare
    name: "cloudflare-fresh desk picks the cloudflare task over the older fly one",
    desk: {
      desk: "engineer",
      recent: [
        worked("fix(do): websocket hibernation drops attachments", "cloudflare"),
        worked("fix(do): storage transaction retries on conflict", "cloudflare"),
      ],
    },
    ready: [
      card(
        "t-fly2",
        "feat(fly): machine autostop configuration",
        "Expose autostop and autostart on the machine resource props.",
        ["fly"],
      ),
      card(
        "t-do",
        "fix(do): alarms are not re-registered after eviction",
        "A Durable Object that set an alarm loses it when evicted mid-window; the constructor must re-register.",
        ["cloudflare"],
      ),
    ],
    want: ["t-do"],
  },
  {
    name: "an urgent priority-1 task outranks the adjacent priority-3",
    desk: {
      desk: "engineer",
      recent: [worked("fix(kv): metadata size limit off by one", "cloudflare")],
    },
    ready: [
      card(
        "t-outage",
        "fix(workers): deploys failing on main — every push red",
        "Every deploy of the worker fails at upload; the whole pipeline is blocked for everyone.",
        ["cloudflare"],
        1,
      ),
      card(
        "t-kv",
        "fix(kv): list pagination cursor expires early",
        "KV list cursors return expired after 60s instead of the documented 5 minutes.",
        ["cloudflare"],
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
        ["cloudflare"],
      ),
      card(
        "t-b",
        "fix(d1): migration runner drops comments",
        "SQL comments in migration files are stripped, breaking checksum verification.",
        ["cloudflare"],
      ),
    ],
    // either real task is a fine pick — the assertion is: not none
    want: ["t-a", "t-b"],
  },
  {
    name: "an unworthy board picks none",
    desk: {
      desk: "engineer",
      recent: [worked("fix(r2): bucket CORS rules drift on adopt", "cloudflare")],
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
