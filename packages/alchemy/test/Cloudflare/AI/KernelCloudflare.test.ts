/**
 * The Cloudflare kernel, live: one Worker, one Durable Object
 * namespace it never declares, and a deterministic model so each
 * assertion is about the KERNEL.
 *
 * What only a deploy can answer, and what each test therefore proves:
 *
 * - binding inference discovers a Durable Object yielded inside a
 *   LAYER (there is no user class) — every test depends on this;
 * - a charter, which is code, reaches a run through the shared layer
 *   build rather than the wire;
 * - the thread is DURABLE: the same key resumes across requests, and
 *   distinct keys are distinct runs in distinct instances;
 * - `AI.reply` answers a round from a tool handler;
 * - delegation crosses Durable Objects, because the actor verbs are
 *   RPC either way;
 * - `Thread.remind` is a real alarm: it wakes a parked run with no
 *   process holding a timer.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import KernelTestWorker from "./fixtures/KernelWorker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "KernelCloudflareStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* KernelTestWorker;
    return { url: worker.url.as<string>() };
  }),
);

const deployed = beforeAll(deploy(Stack));

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

/** Absorb the edge's cold start: non-200s and cold-start defects alike. */
const retryReady = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry({ schedule: readinessSchedule, times: 15 }),
  );

/**
 * Warm the deployment ONCE, before any test runs. A fresh
 * `workers.dev` URL serves 500s for up to a minute while the edge
 * propagates; letting seven concurrent tests each discover that
 * independently just fails whichever one draws the longest cold start.
 */
const stack = beforeAll(
  Effect.gen(function* () {
    const out = yield* deployed;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    yield* client.get(out.url).pipe(
      Effect.catchDefect((defect) => Effect.fail(defect)),
      Effect.retry({ schedule: readinessSchedule, times: 60 }),
    );
    return out;
  }),
  { timeout: 300_000 },
);

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/**
 * Run keys leak into the world and Durable Object storage OUTLIVES a
 * test run, so each run needs fresh ones — a fixed key would inherit
 * the previous run's thread and every count would be off.
 */
const stamp = Date.now();
const runKey = (name: string) => `${name}-${stamp}`;

/** What the deterministic model reports when it isn't calling a tool. */
interface Report {
  readonly users: number;
  readonly tools: number;
  readonly assistants: number;
  readonly last: string | null;
  readonly thread: ReadonlyArray<string>;
}

const drive = (url: string, route: string, params: Record<string, string>) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const query = new URLSearchParams(params).toString();
    const response = yield* client
      .get(`${url}${route}?${query}`)
      .pipe(retryReady);
    return yield* response.json;
  });

const dispatch = (url: string, params: Record<string, string>) =>
  Effect.map(
    drive(url, "/dispatch", params),
    (body) => (body as { answer: unknown }).answer,
  );

const report = (url: string, params: Record<string, string>) =>
  Effect.map(
    dispatch(url, params),
    (answer) => JSON.parse(answer as string) as Report,
  );

test(
  "a run is a Durable Object: dispatch reaches a charter that never crossed the wire",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const key = runKey("hello");

    const answer = yield* report(url, { key, input: "who are you?" });

    // the charter rendered, the work item landed as the one user
    // message, and the model answered — all inside a DO addressed
    // `Scribe/<key>`, with the charter resolved from the shared build
    expect(answer.users).toBe(1);
    expect(answer.last).toBe("who are you?");
  }).pipe(logLevel),
  { timeout: 240_000 },
);

test(
  "AI.reply answers the round with a typed artifact from a tool handler",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const key = runKey("reply");

    // the answer is the ARTIFACT the handler replied with, not the
    // model's closing text — the round is answered where the artifact
    // is produced
    const answer = yield* dispatch(url, { key, input: "call:write:ledger" });
    expect(answer).toEqual({ wrote: "ledger" });
  }).pipe(logLevel),
  { timeout: 240_000 },
);

test(
  "the thread is durable: the same key resumes its conversation",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const key = runKey("resume");

    const first = yield* report(url, { key, input: "first" });
    expect(first.users).toBe(1);

    // a SECOND request, a new DO event (possibly a new isolate): the
    // thread is read back from storage, so the model sees both turns
    const second = yield* report(url, { key, input: "second" });
    expect(second.users).toBe(2);
    expect(second.thread).toContain("first");
    expect(second.last).toBe("second");
  }).pipe(logLevel),
  { timeout: 240_000 },
);

test(
  "distinct keys are distinct runs with separate threads",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const a = runKey("iso-a");
    const b = runKey("iso-b");

    yield* report(url, { key: a, input: "belongs to A" });
    const second = yield* report(url, { key: a, input: "still A" });
    expect(second.users).toBe(2);

    // a different key is a different instance with its own storage —
    // its first round starts from an empty thread
    const other = yield* report(url, { key: b, input: "belongs to B" });
    expect(other.users).toBe(1);
    expect(other.thread).not.toContain("belongs to A");
  }).pipe(logLevel),
  { timeout: 240_000 },
);

test(
  "delegation crosses Durable Objects: the Supervisor's dispatch is an RPC",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const key = runKey("delegate");

    // the Supervisor's charter mentions ${Scribe}, so the kernel gives
    // it a dispatch tool whose handler calls the Scribe's own DO; the
    // child's answer comes back as the tool result, and the
    // Supervisor's report quotes it
    const answer = yield* report(url, {
      agent: "Supervisor",
      key,
      input: "call:delegate:file the report",
    });

    expect(answer.users).toBe(1);
    expect(answer.tools).toBe(1);
  }).pipe(logLevel),
  { timeout: 240_000 },
);

test(
  "Thread.remind is a real alarm: it wakes a parked run with nothing holding a timer",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const key = runKey("remind");

    // round 1 schedules the note and quiesces — the run parks and the
    // DO goes idle; no fiber, no process, just a row and an alarm
    yield* report(url, { key, input: "call:remind:3" });

    // the alarm fires on its own and the note joins the thread as an
    // ordinary input, so the NEXT round sees it
    const woken = yield* Effect.repeat(
      report(url, { key, input: "what happened?" }),
      {
        schedule: Schedule.spaced("3 seconds"),
        until: (answer: Report) =>
          answer.thread.some((entry) => entry.includes("the timer elapsed")),
        times: 8,
      },
    );

    expect(
      woken.thread.some((entry) => entry.includes("the timer elapsed")),
    ).toBe(true);
  }).pipe(logLevel),
  { timeout: 300_000 },
);

test(
  "a round interrupted mid-sampling recovers by ALARM, with no caller waiting",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const key = runKey("recover");
    const directive = `call:crash:r-${stamp}:1`;

    // fire-and-forget: the input lands, the round opens, and the
    // model DIES mid-sampling — the on-disk state is now identical to
    // an eviction or a deploy killing the burst
    yield* drive(url, "/send", { key, input: directive });

    // touch NOTHING: the run must wake itself. The fixture arms
    // recovery at ~3s, so by 15s the alarm has re-entered, the model
    // has succeeded (its crash budget is spent), and the round closed
    yield* Effect.sleep("15 seconds");

    const after = yield* report(url, { key, input: "status" });
    // the input survived the crash (append-first drain)…
    expect(after.thread).toContain(directive);
    // …and was ANSWERED before this poll arrived — only the alarm
    // can have done that, since nothing else touched the run
    expect(after.assistants).toBeGreaterThanOrEqual(1);
    expect(after.users).toBe(2);
  }).pipe(logLevel),
  { timeout: 300_000 },
);

test(
  "a poisoned round exhausts its attempts, is abandoned VISIBLY, and the run keeps serving",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const key = runKey("exhaust");
    const directive = `call:crash:x-${stamp}:99`;

    // a budget of 99 never succeeds: initial burst + 2 alarm
    // re-entries (maxAttempts) all die, then the next alarm abandons
    // the round — total ~21s at the fixture's 3s base backoff
    yield* drive(url, "/send", { key, input: directive });
    yield* Effect.sleep("30 seconds");

    const after = yield* report(url, { key, input: "status" });
    // the abandonment is IN THE THREAD, not swallowed — the model
    // (and any observer) can see the round died
    expect(after.thread.some((entry) => entry.includes("interrupted"))).toBe(
      true,
    );
    // no assistant message ever landed for the poisoned round…
    expect(after.assistants).toBe(0);
    // …but the run still serves: this very report answered, and the
    // crash-loop did NOT run forever (bounded attempts)
    expect(after.last).toBe("status");
  }).pipe(logLevel),
  { timeout: 300_000 },
);

test(
  "settle ends a run from the outside; a settled run ignores further input",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const key = runKey("settle");

    yield* report(url, { key, input: "working" });
    yield* drive(url, "/settle", { key, input: "done" });

    // the outcome is what a settled run answers with, forever after
    const answer = yield* dispatch(url, { key, input: "anyone home?" });
    expect(answer).toEqual({ reason: "done" });
  }).pipe(logLevel),
  { timeout: 240_000 },
);
