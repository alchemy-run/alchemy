/**
 * THE GATE'S SCORECARD — scenarios a natural channel must get right,
 * judged against the REAL System One API (fast and cheap enough to be
 * a test dependency; gated on `TYPESAFE_API_KEY`).
 *
 * Every scenario is a conversation state plus the message that lands,
 * with the routing a human would find intuitive. Some allow a set of
 * outcomes — where reasonable people would disagree, the gate may too.
 * This suite is the tuning loop: change a rubric in src/chat/Gate.ts
 * or the walk in src/chat/Scout.ts, run `bun test test/gate.test.ts`,
 * read the scorecard.
 */
import * as TS from "@distilled.cloud/typesafe-ai";
import { RuntimeContext } from "alchemy";
import type * as TypeSafe from "alchemy/TypeSafe";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  judge,
  type Disposition,
  type Line,
  type Respondent,
} from "../src/chat/Gate.ts";
import {
  referencesOf,
  scout,
  type IssueGraph,
  type PostGraph,
} from "../src/chat/Scout.ts";

const query = ((questions, options) =>
  TS.query(questions, options).pipe(
    Effect.provide([TS.CredentialsFromEnv, FetchHttpClient.layer]),
  )) as typeof TypeSafe.SystemOne.Service;

const ENGINEERING: ReadonlyArray<Respondent> = [
  "manager",
  "engineer",
  "reviewer",
];
const ROOT: ReadonlyArray<Respondent> = ["head"];

/** A served post of the stream — the common case in history. */
const line = (
  id: string,
  author: string,
  text: string,
  rest: Partial<Line> = {},
): Line => ({ id, author, text, status: "settled", ...rest });

interface Scenario {
  readonly name: string;
  readonly roster: ReadonlyArray<Respondent>;
  readonly recent?: ReadonlyArray<Line>;
  readonly message: string;
  /** Acceptable dispositions — one entry when the call is clear-cut. */
  readonly disposition: ReadonlyArray<Disposition>;
  /** Acceptable respondents; omit when anyone is fine. */
  readonly respondent?: ReadonlyArray<Respondent>;
}

/** The transcript that motivated this suite, plus the surrounding space. */
const SCENARIOS: ReadonlyArray<Scenario> = [
  // ── greetings and reactions ────────────────────────────────────────
  {
    name: "bare greeting",
    roster: ENGINEERING,
    message: "hey",
    disposition: ["inline"],
  },
  {
    name: "greeting a member by name",
    roster: ENGINEERING,
    message: "hey manager",
    disposition: ["inline"],
    respondent: ["manager"],
  },
  {
    name: "good morning to the room",
    roster: ENGINEERING,
    message: "good morning everyone",
    disposition: ["inline"],
  },
  {
    name: "thanks closes the exchange",
    roster: ENGINEERING,
    recent: [
      line("a1", "sam", "is the dev server on 1337 or 1340?"),
      line("a2", "engineer", "The UI is on 1337, the worker on 1340."),
    ],
    message: "thanks!",
    disposition: ["ignore"],
  },
  {
    name: "a reaction",
    roster: ENGINEERING,
    message: "👍",
    disposition: ["ignore"],
  },
  // ── the transcript's failures ──────────────────────────────────────
  {
    name: "explicit thread request, vague subject",
    roster: ENGINEERING,
    recent: [
      line("b1", "sam", "hey"),
      line("b2", "manager", "Hey. What do you need?"),
    ],
    message: "start me a thread on something",
    disposition: ["thread"],
    respondent: ["manager"],
  },
  {
    name: "addressed to the manager, subject is the engineer's",
    roster: ENGINEERING,
    message:
      "hey manager, start a thread and ask the engineer what is our testing policy",
    disposition: ["thread"],
    respondent: ["manager"],
  },
  {
    name: "greeting does NOT inherit old, served thread asks",
    roster: ENGINEERING,
    recent: [
      line("c1", "sam", "start me a thread on something"),
      line("c2", "manager", "Filed: Testing Policy Review. #p-oldthread"),
      line("c3", "sam", "hey manager, start a thread about testing policy"),
      line(
        "c4",
        "manager",
        "Thread started #p-oldthread2 — engineer is on it.",
      ),
    ],
    message: "hey",
    disposition: ["inline", "ignore"],
  },
  // ── plain questions stay in the stream ─────────────────────────────
  {
    name: "knowledge question, nobody addressed",
    roster: ENGINEERING,
    message: "what is our testing policy?",
    disposition: ["inline"],
    respondent: ["engineer", "reviewer"],
  },
  {
    name: "addressed technical question",
    roster: ENGINEERING,
    message: "engineer, what port does the dev server run on?",
    disposition: ["inline"],
    respondent: ["engineer"],
  },
  {
    name: "addressed status question",
    roster: ENGINEERING,
    message: "manager, what's the status of the pack ingest work?",
    disposition: ["inline"],
    respondent: ["manager"],
  },
  {
    name: "verdict question about a PR",
    roster: ENGINEERING,
    message: "is #1594 safe to merge?",
    disposition: ["inline"],
    respondent: ["reviewer"],
  },
  // ── real work gets a thread ────────────────────────────────────────
  {
    name: "bug report with a directive",
    roster: ENGINEERING,
    message:
      "the dev worker OOMs when importing the distilled repo — please dig into the pack ingest path",
    disposition: ["thread"],
    respondent: ["engineer"],
  },
  {
    name: "feature request",
    roster: ENGINEERING,
    message: "please add a Railway volume resource with tests",
    disposition: ["thread"],
    respondent: ["engineer", "manager"],
  },
  {
    name: "review request",
    roster: ENGINEERING,
    message: "review #1594 and tell me if the storage math is right",
    disposition: ["thread"],
    respondent: ["reviewer"],
  },
  {
    name: "explicit filing",
    roster: ENGINEERING,
    recent: [
      line(
        "d1",
        "sam",
        "the dev worker OOMs when importing the distilled repo",
      ),
      line(
        "d2",
        "engineer",
        "That's the pack ingest path buffering whole packs in memory.",
      ),
    ],
    message: "file an issue for the OOM and start on it",
    disposition: ["thread"],
    respondent: ["manager", "engineer"],
  },
  // ── context decides ────────────────────────────────────────────────
  {
    name: "follow-up inherits the bug's weight",
    roster: ENGINEERING,
    recent: [
      line("e1", "sam", "the D1 migration fails remotely with uppercase BEGIN"),
      line(
        "e2",
        "engineer",
        "Known quirk — the remote parser only accepts LF-only lowercase begin.",
      ),
    ],
    message: "ugh. can you dig into it and fix it properly?",
    disposition: ["thread"],
    respondent: ["engineer"],
  },
  {
    name: "let's track this properly",
    roster: ENGINEERING,
    recent: [
      line(
        "f1",
        "sam",
        "the pack ingest OOM keeps coming back in different shapes",
      ),
      line(
        "f2",
        "engineer",
        "Each fix has been local; the buffering design is the real culprit.",
      ),
    ],
    message: "let's track this properly",
    disposition: ["thread"],
    respondent: ["manager", "engineer"],
  },
  {
    name: "short follow-up question stays inline",
    roster: ENGINEERING,
    recent: [
      line("g1", "sam", "what is our testing policy?"),
      line(
        "g2",
        "engineer",
        "Behavior lands with its tests; fixtures, never mocks; deterministic and resource-clean.",
      ),
    ],
    message: "and who enforces that on PRs?",
    disposition: ["inline"],
    respondent: ["engineer", "reviewer"],
  },
  // ── the solo room ──────────────────────────────────────────────────
  {
    name: "solo room: greeting",
    roster: ROOT,
    message: "hey",
    disposition: ["inline"],
    respondent: ["head"],
  },
  {
    name: "solo room: note to remember",
    roster: ROOT,
    message: "remember this: the demo is on Thursday at 3pm",
    disposition: ["inline"],
    respondent: ["head"],
  },
  {
    name: "solo room: work request",
    roster: ROOT,
    message: "please dig into why the pack ingest path OOMs on big repos",
    disposition: ["thread"],
    respondent: ["head"],
  },
  {
    name: "solo room: explicit thread",
    roster: ROOT,
    message: "start a thread about preparing the demo",
    disposition: ["thread"],
    respondent: ["head"],
  },
];

describe.skipIf(!process.env.TYPESAFE_API_KEY)("the gate", () => {
  test(
    "routes every scenario the way a human would",
    async () => {
      const results = await Effect.runPromise(
        Effect.forEach(
          SCENARIOS,
          Effect.fn(function* (scenario: Scenario) {
            const verdict = yield* judge(query, {
              channel: scenario.roster === ROOT ? "root" : "engineering",
              message: scenario.message,
              roster: scenario.roster,
              recent: scenario.recent ?? [],
            });
            if (verdict === undefined) {
              return { scenario, ok: false, got: "NO JUDGMENT" };
            }
            const okDisposition = scenario.disposition.includes(
              verdict.disposition,
            );
            const okRespondent =
              scenario.respondent === undefined ||
              scenario.respondent.includes(verdict.respondent);
            return {
              scenario,
              ok: okDisposition && okRespondent,
              got:
                `${verdict.disposition} → ${verdict.respondent} ` +
                `(${verdict.confidence.toFixed(2)}${verdict.addressed ? ", addressed" : ""})`,
            };
          }),
          { concurrency: 4 },
        ).pipe(Effect.provide(RuntimeContext.phantom)),
      );

      const failures = results.filter((row) => !row.ok);
      for (const row of results) {
        console.log(
          `${row.ok ? "✓" : "✗"} ${row.scenario.name.padEnd(52)} ${row.got}` +
            (row.ok
              ? ""
              : `  wanted ${row.scenario.disposition.join("|")}` +
                (row.scenario.respondent
                  ? ` → ${row.scenario.respondent.join("|")}`
                  : "")),
        );
      }
      expect(failures.map((row) => row.scenario.name)).toEqual([]);
    },
    { timeout: 90_000 },
  );
});

// ─── the scout: reference extraction is code ─────────────────────────

describe("referencesOf", () => {
  test("finds issues, cross-repo issues, and post ids", () => {
    expect(referencesOf("can someone look at #1651?")).toEqual([
      { kind: "issue", repo: undefined, number: 1651 },
    ]);
    expect(referencesOf("the fix rode org/floci#9 and #p-abc-123")).toEqual([
      { kind: "issue", repo: "org/floci", number: 9 },
      { kind: "post", id: "p-abc-123" },
    ]);
    expect(referencesOf("no refs here")).toEqual([]);
  });

  test("caps a digest at six references", () => {
    const digest = Array.from({ length: 9 }, (_, i) => `#${i + 1}`).join(" ");
    expect(referencesOf(digest)).toHaveLength(6);
  });
});

// ─── the scout: walk, then judge with evidence ───────────────────────

/** A tiny in-memory forge and post store — the graph the scout walks. */
const ISSUES: IssueGraph = {
  get: (repo, number) =>
    Effect.succeed(
      repo === "org/alchemy" && number === 1651
        ? {
            title:
              "[BUG] Local Lambda log tail silently retries unsupported Floci StartLiveTail",
            state: "open",
            isPull: false,
            merged: false,
            labels: ["bug"],
            body: "Repro: run `alchemy dev` with a Lambda and tail logs; the poller spins on UnsupportedOperation forever.",
          }
        : repo === "org/alchemy" && number === 1594
          ? {
              title: "fix(aws/rds): include coupled storage params on modify",
              state: "closed",
              isPull: true,
              merged: true,
              labels: [],
              body: "Storage modifications now carry iops/throughput together.",
            }
          : undefined,
    ),
};

const OOM_THREAD = [
  {
    id: "p-oom-1",
    author: "sam",
    text: "the dev worker OOMs when importing the distilled repo — pack ingest path",
    status: "settled",
  },
  {
    id: "p-oom-2",
    author: "engineer",
    text: "Root cause: whole packs buffered in memory, filed as #1651. Streaming ingest sketched; parked pending priorities.",
    replyTo: "p-oom-1",
    status: "settled",
  },
];

/** A wide stream: forty noise threads around the three real ones —
 *  the hop must discriminate inside a big candidate set, jev-style. */
const NOISE = Array.from({ length: 40 }, (_, i) => ({
  id: `p-noise-${i}`,
  author: i % 2 === 0 ? "manager" : "sam",
  text: `status sync ${i}: nothing blocking, next check-in tomorrow`,
  status: "settled",
}));

const POSTS: PostGraph = {
  thread: (id) =>
    Effect.succeed(id === "p-oom-1" || id === "p-oom-2" ? OOM_THREAD : []),
  stream: () =>
    Effect.succeed([
      {
        id: "p-greet-1",
        author: "sam",
        text: "good morning everyone",
        status: "settled",
      },
      ...NOISE.slice(0, 20),
      ...OOM_THREAD,
      ...NOISE.slice(20),
      {
        id: "p-d1-1",
        author: "sam",
        text: "the D1 migration fails remotely with uppercase BEGIN",
        status: "settled",
      },
    ]),
};

interface ScoutScenario {
  readonly name: string;
  readonly message: string;
  readonly recent?: ReadonlyArray<Line>;
  readonly disposition: ReadonlyArray<Disposition>;
  readonly respondent?: ReadonlyArray<Respondent>;
  readonly evidence: number;
}

const SCOUT_SCENARIOS: ReadonlyArray<ScoutScenario> = [
  {
    // the reference IS the work: an open bug with a repro
    name: "look at #1651 (open bug) becomes work",
    message: "can someone look at #1651?",
    disposition: ["thread"],
    respondent: ["engineer"],
    evidence: 1,
  },
  {
    // the reference is history: a merged PR being asked about
    name: "status of #1594 (merged PR) stays chat",
    message: "what's the status of #1594?",
    disposition: ["inline"],
    evidence: 1,
  },
  {
    // a large request citing both — the directive decides, the
    // evidence sharpens who
    name: "digest citing #1651 and #1594 with a directive",
    message:
      "we keep hitting OOMs like #1651 and the fix in #1594 didn't hold — dig in and fix it for good",
    disposition: ["thread"],
    respondent: ["engineer"],
    evidence: 2,
  },
  {
    // no explicit reference — the scout must FIND the thread among
    // forty-plus candidates, then JUMP to the issue the thread cites
    name: "implicit reference found by wide graph search",
    message: "let's pick that OOM investigation back up",
    disposition: ["thread"],
    respondent: ["engineer", "manager"],
    evidence: 2,
  },
  {
    // nothing to look at; the scout must not invent a walk
    name: "self-contained chat walks nowhere",
    message: "what is our testing policy?",
    disposition: ["inline"],
    evidence: 0,
  },
];

describe.skipIf(!process.env.TYPESAFE_API_KEY)("the scout", () => {
  test(
    "walks the graph and routes with evidence",
    async () => {
      const results = await Effect.runPromise(
        Effect.forEach(
          SCOUT_SCENARIOS,
          Effect.fn(function* (scenario: ScoutScenario) {
            const outcome = yield* scout(
              {
                query,
                posts: POSTS,
                issues: ISSUES,
                defaultRepo: "org/alchemy",
              },
              {
                channel: "engineering",
                message: scenario.message,
                roster: ENGINEERING,
                recent: scenario.recent ?? [],
              },
            );
            if (outcome === undefined) {
              return { scenario, ok: false, got: "NO JUDGMENT" };
            }
            const { verdict, evidence } = outcome;
            const ok =
              scenario.disposition.includes(verdict.disposition) &&
              (scenario.respondent === undefined ||
                scenario.respondent.includes(verdict.respondent)) &&
              evidence.length === scenario.evidence;
            return {
              scenario,
              ok,
              got:
                `${verdict.disposition} → ${verdict.respondent} ` +
                `(${verdict.confidence.toFixed(2)}, evidence ${evidence.length}: ` +
                `${evidence.map((card) => card.ref).join(", ") || "—"})`,
            };
          }),
          { concurrency: 2 },
        ).pipe(Effect.provide(RuntimeContext.phantom)),
      );

      const failures = results.filter((row) => !row.ok);
      for (const row of results) {
        console.log(
          `${row.ok ? "✓" : "✗"} ${row.scenario.name.padEnd(52)} ${row.got}` +
            (row.ok
              ? ""
              : `  wanted ${row.scenario.disposition.join("|")}` +
                (row.scenario.respondent
                  ? ` → ${row.scenario.respondent.join("|")}`
                  : "") +
                ` with ${row.scenario.evidence} evidence`),
        );
      }
      expect(failures.map((row) => row.scenario.name)).toEqual([]);
    },
    { timeout: 120_000 },
  );
});
