import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { expectUrlContains } from "../Utils/Http.ts";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import Stack from "./fixtures/wait-until/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Cache-busting query param on every request: after destroy+recreate of the
// same workers.dev subdomain the edge can serve a cached "nothing here yet"
// placeholder (with a 200) for the bare URL even though busted requests
// already reach the worker. Route matching uses `url.pathname`, so the
// param is invisible to the fixture.
let bust = 0;
const getText = Effect.fn(function* (url: string) {
  const request = yield* Effect.sync(() =>
    HttpClientRequest.get(`${url}?cb=${Date.now()}-${bust++}`).pipe(
      HttpClientRequest.setHeader("cache-control", "no-cache"),
    ),
  );
  const response = yield* requestWorker(request);
  const body = yield* response.text;
  if (response.status !== 200) {
    return yield* Effect.fail(new Error(`GET ${url}: ${response.status}: ${body}`));
  }
  return body;
});

// Journal labels are unique per run: the DO's storage outlives a run when
// NO_DESTROY keeps the deployment.
const run = crypto.randomUUID().slice(0, 8);

const journalEntries = Effect.fn(function* (url: string, label: string, count: number, polls = 20) {
  return yield* Effect.gen(function* () {
    const text = yield* getText(`${url}/lifetime/entries/${label}`);
    return yield* Effect.try({
      try: () => (JSON.parse(text) as { entries: string[] }).entries,
      catch: (cause) => new Error(`Invalid journal response: ${text}`, { cause }),
    });
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: (entries) => entries.length >= count,
      times: polls,
    }),
  );
});

describe.skipIf(!!process.env.FAST)(
  "waitUntil work outlives the event's response but not its scope",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    // Each case binds a resource to the event's scope and hands `waitUntil`
    // work that uses it 200ms after the event returns. The scope must wait
    // for that work: the work sees the resource `open`, and the release is
    // journaled after it.
    for (const [kind, response] of [
      ["worker", "scheduled"],
      ["nested", "scheduled"],
      ["failing", "scheduled"],
      ["stream", "streamed"],
      ["scoped-acquire", "scheduled"],
      ["nested-acquire", "scheduled"],
      ["rpc", "scheduled"],
      ["rpc-stream", "a,b"],
      ["rpc-stream-wait-until", "a"],
      ["queue", "scheduled"],
      ["do", "scheduled"],
      ["do-nested", "scheduled"],
      ["do-failing", "scheduled"],
      ["do-fails", "failed"],
      ["do-scoped-acquire", "scheduled"],
      ["do-stream", "a,b"],
      ["do-stream-wait-until", "a"],
      ["do-fetch", "scheduled"],
      ["do-alarm", "scheduled"],
    ] as const) {
      test(
        `the event's scope stays open for waitUntil work (${kind})`,
        Effect.gen(function* () {
          const { url } = yield* stack;
          yield* expectUrlContains(`${url}/raw`, "ok", {
            label: "wait-until worker propagation",
          });
          const label = `${kind}-${run}`;
          expect(yield* getText(`${url}/lifetime/${kind}/${label}`)).toBe(response);
          // A queue batch arrives after a second, and an early one can land
          // on the precreate placeholder and be retried.
          expect(yield* journalEntries(url, label, 2, kind === "queue" ? 80 : 20)).toEqual([
            `${label}:open`,
            `${label}:released`,
          ]);
        }).pipe(logLevel),
        { timeout: 120_000 },
      );
    }

    test(
      "the event's scope stays open for waitUntil work (failed handler)",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectUrlContains(`${url}/raw`, "ok", {
          label: "wait-until worker propagation",
        });
        const label = `fails-${run}`;
        const response = yield* requestWorker(
          HttpClientRequest.get(`${url}/lifetime/fails/${label}?cb=${Date.now()}-${bust++}`),
        );
        expect(response.status).toBe(500);
        expect(yield* journalEntries(url, label, 2)).toEqual([
          `${label}:open`,
          `${label}:released`,
        ]);
      }).pipe(logLevel),
      { timeout: 120_000 },
    );

    // The producer's trace reaches the fixture's `tail` handler.
    test(
      "the event's scope stays open for waitUntil work (tail)",
      Effect.gen(function* () {
        const { url, producerUrl } = yield* stack;
        yield* expectUrlContains(`${url}/raw`, "ok", {
          label: "wait-until worker propagation",
        });
        const label = `tail-${run}`;
        yield* expectUrlContains(`${producerUrl}/${label}`, "logged", {
          label: "tail producer",
        });
        expect(yield* journalEntries(url, label, 2, 80)).toEqual([
          `${label}:open`,
          `${label}:released`,
        ]);
      }).pipe(logLevel),
      { timeout: 120_000 },
    );

    // The fixture's `* * * * *` trigger journals each tick under
    // `cron-<minute>`. New schedules take up to 15 minutes to propagate, so
    // keep the fixture with NO_DESTROY=1 before opting in; the local suite
    // covers scheduled dispatch without waiting.
    test.skipIf(process.env.CLOUDFLARE_TEST_CRON_DELIVERY !== "1")(
      "the event's scope stays open for waitUntil work (scheduled)",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectUrlContains(`${url}/raw`, "ok", {
          label: "wait-until worker propagation",
        });
        const next = Math.ceil(Date.now() / 60_000) * 60_000;
        // A trigger can miss its first tick after a deploy.
        const ticks = [next, next + 60_000];
        const entries = yield* Effect.forEach(ticks, (tick) =>
          getText(`${url}/lifetime/entries/cron-${tick}`).pipe(
            Effect.map((text) => (JSON.parse(text) as { entries: string[] }).entries),
          ),
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (entries) => entries.some((tick) => tick.length >= 2),
            times: 75,
          }),
        );
        const index = entries.findIndex((tick) => tick.length >= 2);
        expect(index).toBeGreaterThanOrEqual(0);
        const label = `cron-${ticks[index]}`;
        expect(entries[index]).toEqual([`${label}:open`, `${label}:released`]);
      }).pipe(logLevel),
      { timeout: 180_000 },
    );

    // A HEAD response drops its streamed body without reading it.
    test(
      "the event's scope stays open for waitUntil work (HEAD of a streamed body)",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectUrlContains(`${url}/raw`, "ok", {
          label: "wait-until worker propagation",
        });
        const label = `head-${run}`;
        const response = yield* requestWorker(
          HttpClientRequest.head(`${url}/lifetime/stream/${label}?cb=${Date.now()}-${bust++}`),
        );
        expect(response.status).toBe(200);
        expect(yield* journalEntries(url, label, 2)).toEqual([
          `${label}:open`,
          `${label}:released`,
        ]);
      }).pipe(logLevel),
      { timeout: 120_000 },
    );

    test(
      "the event's scope stays open for waitUntil work (Durable Object WebSocket message)",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectUrlContains(`${url}/raw`, "ok", {
          label: "wait-until worker propagation",
        });
        const label = `socket-${run}`;
        const reply = yield* Effect.callback<string, Error>((resume) => {
          const socket = new WebSocket(`${url.replace(/^http/, "ws")}/socket/${label}`);
          socket.addEventListener("open", () => socket.send(label));
          socket.addEventListener("message", (event) => {
            resume(Effect.succeed(String(event.data)));
            socket.close();
          });
          socket.addEventListener("error", () => resume(Effect.fail(new Error("socket error"))));
          return Effect.sync(() => socket.close());
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 5 }),
        );
        expect(reply).toBe("scheduled");
        expect(yield* journalEntries(url, label, 2)).toEqual([
          `${label}:open`,
          `${label}:released`,
        ]);
      }).pipe(logLevel),
      { timeout: 120_000 },
    );

    // The event outlives these responses, but the responses must not wait
    // for it: each hands off work that sleeps 3 seconds before journaling.
    for (const [kind, response] of [
      ["scoped", "scheduled"],
      ["slow-stream", "streamed"],
      ["do-slow-stream", "a,b"],
    ] as const) {
      test(
        `waitUntil work does not hold the response (${kind})`,
        Effect.gen(function* () {
          const { url } = yield* stack;
          yield* expectUrlContains(`${url}/raw`, "ok", {
            label: "wait-until worker propagation",
          });
          const label = `${kind}-${run}`;
          const [elapsed, body] = yield* getText(`${url}/lifetime/${kind}/${label}`).pipe(
            Effect.timed,
          );
          expect(body).toBe(response);
          expect(Duration.toMillis(elapsed)).toBeLessThan(2_500);
          expect(yield* journalEntries(url, label, 1)).toEqual([`${label}:done`]);
        }).pipe(logLevel),
        { timeout: 120_000 },
      );
    }

    test(
      "the event's scope stays open for waitUntil work (HttpApi handler)",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectUrlContains(`${url}/raw`, "ok", {
          label: "wait-until worker propagation",
        });
        const label = `api-${run}`;
        expect(yield* getText(`${url}/api/lifetime/${label}`)).toBe('"scheduled"');
        expect(yield* journalEntries(url, label, 2)).toEqual([
          `${label}:open`,
          `${label}:released`,
        ]);
      }).pipe(logLevel),
      { timeout: 120_000 },
    );
  },
);

/**
 * Read a streamed body line by line, stopping after `take` lines when given.
 * A body that ends with an error keeps the lines read before it.
 */
const readLines = Effect.fn(function* (url: string, take?: number) {
  const lines: string[] = [];
  const response = yield* requestWorker(
    HttpClientRequest.get(`${url}?cb=${Date.now()}-${bust++}`).pipe(
      HttpClientRequest.setHeader("cache-control", "no-cache"),
      HttpClientRequest.setHeader("connection", "close"),
    ),
  );
  const body = response.stream.pipe(Stream.decodeText, Stream.splitLines);
  const exit = yield* (take === undefined ? body : body.pipe(Stream.take(take))).pipe(
    Stream.runForEach((line) => Effect.sync(() => void lines.push(line))),
    Effect.timeout("10 seconds"),
    Effect.exit,
  );
  return { status: response.status, lines, failed: Exit.isFailure(exit) };
});

describe.skipIf(!!process.env.FAST)(
  "a streamed result keeps the event's scope open until it ends",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    // Each body reads a resource bound to the event's scope as it streams.
    // The resource must be open for every line, and released once the
    // stream ends however it ends: drained, failing, or cancelled by the
    // client.
    for (const target of ["worker", "do-fetch", "do-rpc"] as const) {
      for (const mode of ["complete", "fail", "cancel"] as const) {
        test(
          `${target} stream: ${mode}`,
          Effect.gen(function* () {
            const { url } = yield* stack;
            yield* expectUrlContains(`${url}/raw`, "ok", {
              label: "wait-until worker propagation",
            });
            const label = `stream-${target}-${mode}-${run}`;
            const { status, lines } = yield* readLines(
              `${url}/stream/${target}/${mode}/${label}`,
              mode === "cancel" ? 2 : undefined,
            );
            expect(status).toBe(200);
            // A failing Web stream drops the chunks still queued when it errors.
            if (mode === "fail") expect(lines.length).toBeGreaterThan(0);
            else expect(lines).toHaveLength(mode === "complete" ? 3 : 2);
            expect(lines.every((line) => line === "open")).toBe(true);
            expect(yield* journalEntries(url, label, 1)).toEqual([`${label}:released`]);
          }).pipe(logLevel),
          { timeout: 120_000 },
        );
      }
    }
  },
);

describe.skipIf(!!process.env.FAST)(
  "waitUntil runs background Effects past the response (worker ctx + DO state)",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    test(
      "concurrent background journal writes retain every entry",
      Effect.gen(function* () {
        const { url } = yield* stack;
        yield* expectUrlContains(`${url}/raw`, "ok", {
          label: "wait-until worker propagation",
        });
        const label = `parallel-${run}`;
        expect(yield* getText(`${url}/bg-many/${label}`)).toBe("bg-many-scheduled");
        const entries = yield* journalEntries(url, label, 40, 16);
        expect(entries.toSorted()).toEqual(
          Array.from({ length: 40 }, (_, i) => `parallel-${i}`).sort(),
        );
      }).pipe(logLevel),
      { timeout: 60_000 },
    );

    test(
      "waitUntil runs background Effects past the response (worker ctx + DO state)",
      Effect.gen(function* () {
        const { url } = yield* stack;

        // Content-based readiness through workers.dev propagation (the
        // placeholder page serves 200s); also asserts the raw escape hatch is
        // the genuine workerd ExecutionContext.
        yield* expectUrlContains(`${url}/raw`, "ok", {
          label: "wait-until worker propagation",
        });

        // Fire both background writes: one from the Worker's ExecutionContext,
        // one from inside the DO via DurableObjectState.waitUntil. Both routes
        // respond before the journal entry is persisted. Probed via
        // expectUrlContains so transient placeholders/5xx during propagation
        // are retried (a duplicate journal entry from a retry is harmless —
        // the assertions below use `toContain`).
        yield* expectUrlContains(`${url}/bg`, "bg-scheduled", {
          label: "waitUntil /bg",
        });
        yield* expectUrlContains(`${url}/bg-do`, "bg-do-scheduled", {
          label: "waitUntil /bg-do",
        });
        // Regression for #2173: an HttpApi handler built in init sees the
        // live per-event context, not init's deferred stand-in.
        yield* expectUrlContains(`${url}/api/bg`, "bg-api-scheduled", {
          label: "waitUntil /api/bg",
        });

        // The entries only appear if waitUntil kept the invocations alive until
        // the delayed writes completed.
        const entries = yield* Effect.gen(function* () {
          const text = yield* getText(`${url}/entries`);
          // The workers.dev placeholder serves HTML with a 200 during subdomain
          // propagation; a bare JSON.parse throw would be a *defect* that the
          // `Effect.catch` below can't see, so parse as a typed failure.
          const body = yield* Effect.try(() => JSON.parse(text) as { entries?: string[] });
          return body.entries ?? [];
        }).pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (entries) =>
              entries.includes("from-worker-wait-until") &&
              entries.includes("from-do-wait-until") &&
              entries.includes("from-http-api-wait-until"),
            times: 30,
          }),
        );

        expect(entries).toContain("from-worker-wait-until");
        expect(entries).toContain("from-do-wait-until");
        expect(entries).toContain("from-http-api-wait-until");
      }).pipe(logLevel),
      { timeout: 180_000 },
    );

    // Scope finalizers piggyback on the same mechanism: the bridge closes the
    // per-event scope after the handler completes and registers the close
    // promise with waitUntil, so `Effect.addFinalizer` work lands after the
    // response without blocking it.
    test(
      "Effect.addFinalizer runs after the response (request scope + DO call scope)",
      Effect.gen(function* () {
        const { url } = yield* stack;

        // Content-based readiness: a fresh workers.dev URL serves Cloudflare's
        // placeholder page (with a 200) while the subdomain propagates.
        yield* expectUrlContains(`${url}/raw`, "ok", {
          label: "wait-until worker propagation",
        });

        // Both routes respond before their finalizers persist the entries.
        // Probed via expectUrlContains so transient placeholders/5xx during
        // propagation are retried (duplicate journal entries are harmless —
        // the assertions below use `toContain`).
        yield* expectUrlContains(`${url}/finalizer`, "finalizer-scheduled", {
          label: "finalizer /finalizer",
        });
        yield* expectUrlContains(`${url}/finalizer-do`, "do-finalizer-scheduled", {
          label: "finalizer /finalizer-do",
        });

        const entries = yield* Effect.gen(function* () {
          const text = yield* getText(`${url}/entries`);
          // The workers.dev placeholder serves HTML with a 200 during subdomain
          // propagation; a bare JSON.parse throw would be a *defect* that the
          // `Effect.catch` below can't see, so parse as a typed failure.
          const body = yield* Effect.try(() => JSON.parse(text) as { entries?: string[] });
          return body.entries ?? [];
        }).pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (entries) =>
              entries.includes("from-request-finalizer") && entries.includes("from-do-finalizer"),
            times: 30,
          }),
        );

        expect(entries).toContain("from-request-finalizer");
        expect(entries).toContain("from-do-finalizer");

        // Init-phase semantics (documented on the Worker resource): the init
        // closure runs exactly once per isolate — the bridge builds the layer
        // stack on the first event and every later event reuses the built
        // context. The build scope is never closed (workerd has no isolate
        // teardown), so a finalizer added in the init closure NEVER fires;
        // request-coupled cleanup belongs in handlers, where `addFinalizer`
        // attaches to the per-event scope (asserted above). Each observation
        // may come from a different isolate, but every isolate must report
        // exactly one init run and zero init-finalizer runs no matter how many
        // events it has served.
        const observation = yield* Effect.gen(function* () {
          const init = Number(yield* getText(`${url}/init-runs`));
          const finalized = Number(yield* getText(`${url}/init-finalizer-runs`));
          return { init, finalized };
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (o) => o.init === 1 && o.finalized === 0,
            times: 10,
          }),
        );
        expect(observation).toEqual({ init: 1, finalized: 0 });
      }).pipe(logLevel),
      { timeout: 180_000 },
    );
  },
);
