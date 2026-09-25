import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/rpc-object/stack.ts";

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  url: string;
}> {}

const requestJson = <T = Record<string, unknown>>(
  url: string,
  method: "GET" | "POST" = "GET",
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* method === "GET"
      ? client.get(url)
      : client.post(url);
    const body = yield* response.text;
    if (
      (response.status === 404 || response.status === 200) &&
      body.includes("<title>Page not found</title>") &&
      body.includes("https://workers.cloudflare.com/favicon.ico")
    ) {
      return yield* Effect.fail(new WorkerNotReady({ url }));
    }
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`${method} ${url}: HTTP ${response.status}: ${body}`),
      );
    }
    return yield* Effect.try({
      try: () => JSON.parse(body) as T,
      catch: () => new Error(`${method} ${url}: invalid JSON: ${body}`),
    });
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof WorkerNotReady,
      schedule: Schedule.spaced("2 seconds"),
      times: 8,
    }),
    Effect.timeout("50 seconds"),
  );

interface Failure {
  failed: boolean;
  interrupted: boolean;
  diagnostic: string;
}

interface OpenResult extends Record<string, unknown> {
  ping: string;
  beforeClose: string[];
}

interface PerformanceResult {
  iterations: number;
  directRootMs: number;
  directRootValues: number[];
  rootMs: number;
  returnedMs: number;
  returnedToRootRatio: number | null;
  rootValues: number[];
  returnedValues: number[];
  largeRecords: { count: number; bytes: number; sum: number; ms: number };
  bytes: {
    size: number;
    checksum: number;
    ms: number;
    bytesPerSecond: number | null;
  };
  objects: {
    count: number;
    first: unknown;
    last: unknown;
    size: number;
    ms: number;
    bytesPerSecond: number | null;
  };
  stream: {
    bytes: number;
    checksum: number;
    ms: number;
    bytesPerSecond: number | null;
  };
}

const count = (events: string[], event: string) =>
  events.filter((value) => value === event).length;
const assertOpen = (result: OpenResult, id: string) => {
  expect(result.ping).toBe(id);
  expect(count(result.beforeClose, "parent:open")).toBe(1);
  expect(count(result.beforeClose, "parent:close")).toBe(0);
};

const closed = Effect.fn(function* (url: string, id: string, owner = "parent") {
  const read = requestJson<{ events: string[] }>(`${url}/stats/${id}`).pipe(
    Effect.timeout("5 seconds"),
  );
  const result = yield* read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      times: 8,
      until: ({ events }) => events.includes(`${owner}:close`),
    }),
  );
  expect(count(result.events, `${owner}:open`)).toBe(1);
  expect(count(result.events, `${owner}:close`)).toBe(1);
  expect(result.events.indexOf(`${owner}:close`)).toBeGreaterThan(
    result.events.indexOf(`${owner}:open`),
  );
  // Re-read durable state after disposal settles, rather than trusting one snapshot.
  yield* Effect.sleep("200 millis");
  const settled = yield* read;
  expect(settled.events).toEqual(result.events);
  return settled.events;
});

describe.concurrent.each([
  { dev: true, stage: "rpc-object-local" },
  { dev: false, stage: "rpc-object-live" },
])("returned RPC objects (dev: $dev)", ({ dev, stage }) => {
  const options = {
    timeout: 90_000,
    retry: 0,
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      dev ? "local" : "live",
    ],
  };
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    dev,
    stage,
  });
  const stack = beforeAll(
    Effect.gen(function* () {
      yield* destroy(Stack);
      const output = yield* deploy(Stack);
      // Application failures and test bodies never retry; only the pre-handler edge placeholder does.
      const ready = yield* requestJson<{ ready: string[] }>(
        `${output.url}/ready`,
      ).pipe(
        Effect.timeout("5 seconds"),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
      );
      expect(ready.ready).toEqual([
        "metrics-ready",
        "metrics-ready",
        "metrics-ready",
      ]);
      expect(output.url.startsWith("http://localhost:")).toBe(dev);
      return output;
    }),
    { timeout: 120_000, retry: 0 },
  );
  afterAll(destroy(Stack), { timeout: 60_000 });

  for (const transport of ["worker", "do"] as const) {
    const idFor = (scenario: string) => `${transport}-${scenario}`;
    const call = <T = Record<string, unknown>>(url: string, scenario: string) =>
      Effect.gen(function* () {
        if (transport === "do") {
          // Probe the actual object; a different ID can be served by another isolate.
          const ready = yield* requestJson<{ ready: string[] }>(
            `${url}/ready/${idFor(scenario)}`,
          ).pipe(
            Effect.timeout("5 seconds"),
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
          );
          expect(ready.ready).toEqual([
            "metrics-ready",
            "metrics-ready",
            "metrics-ready",
          ]);
        }
        return yield* requestJson<T>(
          `${url}/${transport}/${scenario}/${idFor(scenario)}`,
          "POST",
        );
      });

    test(
      `${transport}: legacy receivers fall back before application execution`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const result = yield* call<{ value: string; failure: Failure }>(
          url,
          "legacy",
        );
        expect(result.value).toBe(idFor("legacy"));
        expect(result.failure.failed).toBe(true);
        expect(result.failure.diagnostic).toContain(
          "legacy application failure",
        );
      }),
      options,
    );

    test(
      `${transport}: native stream batches account for typed-array backing buffers`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        expect(yield* call(url, "backing-buffers")).toEqual({
          count: 65,
          sum: 2080,
        });
        yield* closed(url, idFor("backing-buffers"));
      }),
      options,
    );

    test(
      `${transport}: returned methods run with the host RuntimeContext`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        expect(yield* call(url, "runtime-context")).toEqual({
          value: "Cloudflare.Worker",
          values: ["Cloudflare.Worker"],
        });
        yield* closed(url, idFor("runtime-context"));
      }),
      options,
    );

    test(
      `${transport}: pure factories use the event scope and preserve generic/correlated values`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        expect(yield* call(url, "pure")).toEqual({
          literal: "generic",
          number: 42,
          label: "answer",
          nested: { kind: "record", values: [1, 2, 3] },
        });
      }),
      options,
    );

    test(
      `${transport}: returned methods round-trip native structured-clone values`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<OpenResult>(url, "roundtrip");
        expect(body.scalar).toEqual({
          text: "hello 🦊",
          number: 42.5,
          boolean: false,
          null: null,
          undefinedOwn: true,
          bigint: "9007199254740993",
          nan: true,
          positiveInfinity: true,
          negativeInfinity: true,
          negativeZero: true,
        });
        expect(body.forwarded).toEqual({
          forwarded: true,
          nested: { value: 42 },
        });
        expect(body.date).toEqual({
          native: true,
          iso: "2026-09-20T12:34:56.789Z",
        });
        expect(body.map).toEqual({
          native: true,
          entries: [
            ["one", { value: 1 }],
            ["two", { value: 2 }],
          ],
        });
        expect(body.set).toEqual({ native: true, values: ["alpha", "beta"] });
        expect(body.regexp).toEqual({
          native: true,
          source: "hello\\s+(world)",
          flags: "gi",
          matches: true,
        });
        expect(body.error).toEqual({
          native: true,
          name: "TypeError",
          message: "data error, not a failed call",
        });
        expect(body.buffer).toEqual({ native: true, bytes: [0, 255, 17, 42] });
        expect(body.typed).toEqual({ native: true, values: [0, 256, 65535] });
        expect(body.topNull).toBeNull();
        expect(body.topUndefined).toBe(true);
        expect(body.topBigint).toBe("1234567890123456789");
        expect(body.literal).toBe("correlated");
        expect(body.selected).toBe(7);
        assertOpen(body, idFor("roundtrip"));
        yield* closed(url, idFor("roundtrip"));
      }),
      options,
    );

    test(
      `${transport}: byte, JSON, empty, delayed, failed and cancelled streams retain their parent`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<OpenResult & { failure: Failure }>(
          url,
          "streams",
        );
        expect(body.bytes).toEqual([0, 1, 255, 2, 3]);
        expect(body.json).toEqual([
          { index: 0, value: "alpha" },
          { index: 1, value: "beta" },
        ]);
        expect(body.empty).toEqual([]);
        expect(body.delayed).toEqual([1, 2, 3]);
        expect(body.delivered).toEqual(["before-failure"]);
        expect(body.failure.failed).toBe(true);
        expect(body.failure.diagnostic).toContain("ObjectRejected");
        expect(body.failure.diagnostic).toContain("stream rejected");
        expect(body.cancelled).toEqual(["first"]);
        assertOpen(body, idFor("streams"));
        const events = yield* closed(url, idFor("streams"));
        for (const name of [
          "bytes",
          "json",
          "empty",
          "delayed",
          "failing",
          "cancel",
        ]) {
          expect(count(events, `stream:${name}:open`)).toBe(1);
          expect(count(events, `stream:${name}:close`)).toBe(1);
          expect(events.indexOf(`stream:${name}:close`)).toBeLessThan(
            events.indexOf("parent:close"),
          );
        }
      }),
      options,
    );

    test(
      `${transport}: rich streams preserve native values, undefined, NaN and cyclic data`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<OpenResult>(url, "rich-streams");
        expect(body.values).toEqual([
          { type: "undefined" },
          { type: "NaN" },
          { type: "bigint", value: "9007199254740993" },
          { type: "Date", value: "2026-09-20T12:34:56.789Z" },
          { type: "Map", entries: [["one", { type: "bigint", value: "1" }]] },
          { type: "Set", values: ["alpha", "beta"] },
          { type: "Uint16Array", values: [0, 256, 65535] },
          {
            nested: {
              bigint: { type: "bigint", value: "1234567890123456789" },
              date: { type: "Date", value: "2026-01-02T03:04:05.000Z" },
              map: {
                type: "Map",
                entries: [
                  [
                    "set",
                    {
                      type: "Set",
                      values: [
                        { type: "bigint", value: "2" },
                        { type: "bigint", value: "3" },
                      ],
                    },
                  ],
                ],
              },
              bytes: { type: "Uint8Array", values: [0, 255, 42] },
              words: { type: "Uint16Array", values: [256, 65535] },
              undefined: { type: "undefined" },
              nan: { type: "NaN" },
            },
          },
          { label: "cycle", self: { $ref: "$" } },
        ]);
        assertOpen(body, idFor("rich-streams"));
        const events = yield* closed(url, idFor("rich-streams"));
        expect(count(events, "stream:rich:open")).toBe(1);
        expect(count(events, "stream:rich:close")).toBe(1);
        expect(events.indexOf("stream:rich:close")).toBeLessThan(
          events.indexOf("parent:close"),
        );
      }),
      options,
    );

    test(
      `${transport}: initial and post-byte stream failures remain typed and finalize once`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<OpenResult>(url, "stream-failures");
        expect(body.initialItems).toBe(0);
        expect(body.initialError).toEqual({
          tag: "ObjectRejected",
          code: 400,
          message: "stream rejected before first item",
        });
        expect(body.bytes).toEqual([0, 17, 255]);
        expect(body.byteError).toEqual({
          tag: "ObjectRejected",
          code: 502,
          message: "stream rejected after bytes",
        });
        assertOpen(body, idFor("stream-failures"));
        const events = yield* closed(url, idFor("stream-failures"));
        for (const name of ["initial-failure", "byte-failure"]) {
          expect(count(events, `stream:${name}:open`)).toBe(1);
          expect(count(events, `stream:${name}:close`)).toBe(1);
          expect(events.indexOf(`stream:${name}:close`)).toBeLessThan(
            events.indexOf("parent:close"),
          );
        }
      }),
      options,
    );

    test(
      `${transport}: delayed first items and cancellation before any item retain their parent`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<OpenResult & { interrupted: Failure }>(
          url,
          "stream-first-item",
        );
        expect(body.delayed).toEqual([{ value: "first-after-delay" }]);
        expect(body.cancelledItems).toBe(0);
        expect(body.interrupted.failed).toBe(true);
        expect(body.interrupted.interrupted).toBe(true);
        assertOpen(body, idFor("stream-first-item"));
        const events = yield* closed(url, idFor("stream-first-item"));
        for (const name of ["delayed-first", "pending-first"]) {
          expect(count(events, `stream:${name}:open`)).toBe(1);
          expect(count(events, `stream:${name}:close`)).toBe(1);
          expect(events.indexOf(`stream:${name}:close`)).toBeLessThan(
            events.indexOf("parent:close"),
          );
        }
      }),
      options,
    );

    test(
      `${transport}: child failure, stream completion and child disposal leave the parent reusable`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<OpenResult>(url, "nested");
        expect(body.child).toEqual({
          value: { child: true },
          rejected: { tag: "ObjectRejected", code: 410 },
          values: ["child-a", "child-b"],
          ping: idFor("nested"),
        });
        assertOpen(body, idFor("nested"));
        expect(count(body.beforeClose, "child:close")).toBe(1);
        const events = yield* closed(url, idFor("nested"));
        for (const owner of ["child", "stream:child"]) {
          expect(count(events, `${owner}:open`)).toBe(1);
          expect(count(events, `${owner}:close`)).toBe(1);
        }
        expect(events.indexOf("stream:child:close")).toBeLessThan(
          events.indexOf("child:close"),
        );
        expect(events.indexOf("child:close")).toBeLessThan(
          events.indexOf("parent:close"),
        );
      }),
      options,
    );

    test(
      `${transport}: typed failures, defects and interrupted methods finalize exactly once`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<
          OpenResult & {
            defect: Failure;
            methodFailure: Failure;
            interrupted: Failure;
          }
        >(url, "failures");
        expect(body.rejected).toEqual({
          tag: "ObjectRejected",
          code: 409,
          message: "object rejected",
        });
        expect(body.defect.failed).toBe(true);
        expect(body.defect.diagnostic).toContain("object defect");
        expect(body.success).toBe("method-ok");
        expect(body.methodFailure.failed).toBe(true);
        expect(body.methodFailure.diagnostic).toContain("method rejected");
        expect(body.interrupted.interrupted).toBe(true);
        assertOpen(body, idFor("failures"));
        const events = yield* closed(url, idFor("failures"));
        for (const mode of ["success", "failure", "interrupt"]) {
          expect(count(events, `method:${mode}:open`)).toBe(1);
          expect(count(events, `method:${mode}:close`)).toBe(1);
          expect(events.indexOf(`method:${mode}:close`)).toBeLessThan(
            events.indexOf("parent:close"),
          );
        }
      }),
      options,
    );

    test(
      `${transport}: concurrent returned-object calls preserve response correlation`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<OpenResult>(url, "concurrent");
        expect(body.values).toEqual(
          Array.from({ length: 24 }, (_, index) => ({
            index,
            label: `call-${index}`,
          })),
        );
        assertOpen(body, idFor("concurrent"));
        yield* closed(url, idFor("concurrent"));
      }),
      options,
    );

    for (const scenario of [
      "scope-success",
      "scope-failure",
      "scope-interruption",
    ] as const) {
      test(
        `${transport}: ${scenario} closes the factory resource exactly once`,
        Effect.gen(function* () {
          const { url } = yield* stack;
          const body = yield* call<{ exit: Failure; value?: string | null }>(
            url,
            scenario,
          );
          expect(body.exit.failed).toBe(scenario !== "scope-success");
          expect(body.exit.interrupted).toBe(scenario === "scope-interruption");
          if (scenario === "scope-success") expect(body.value).toBe("scope-ok");
          if (scenario === "scope-failure")
            expect(body.exit.diagnostic).toContain("CallerRejected");
          const events = yield* closed(url, idFor(scenario));
          expect(count(events, "parent:ping")).toBe(1);
        }),
        options,
      );
    }

    test(
      `${transport}: interrupted factory acquisition releases its acquired resource`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<{ exit: Failure }>(
          url,
          "factory-interruption",
        );
        expect(body.exit.interrupted).toBe(true);
        expect(
          yield* closed(url, idFor("factory-interruption"), "factory"),
        ).toEqual(["factory:open", "factory:close"]);
      }),
      options,
    );

    test(
      `${transport}: use after scope fails promptly without invoking the disposed object`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<{ exit: Failure; events: string[] }>(
          url,
          "use-after-scope",
        );
        expect(body.exit.failed).toBe(true);
        expect(body.exit.interrupted).toBe(false);
        expect(body.exit.diagnostic.length).toBeGreaterThan(0);
        expect(body.exit.diagnostic).not.toContain("TimeoutError");
        expect(body.events).toEqual([
          "parent:open",
          "parent:ping",
          "parent:close",
        ]);
        yield* closed(url, idFor("use-after-scope"));
      }),
      options,
    );

    test(
      `${transport}: performance report for root versus returned calls and payload throughput`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* call<PerformanceResult>(url, "performance");
        expect(body.iterations).toBe(30);
        const expected = Array.from(
          { length: body.iterations },
          (_, index) => index + 1,
        );
        expect(body.directRootValues).toEqual(expected);
        expect(body.rootValues).toEqual(expected);
        expect(body.returnedValues).toEqual(expected);
        expect(body.largeRecords.count).toBe(128);
        expect(body.largeRecords.bytes).toBe(128 * 300 * 1024);
        expect(body.largeRecords.sum).toBe(8128);
        expect(body.bytes.size).toBe(256 * 1024);
        expect(body.bytes.checksum).toBe(37 * 256 * 1024);
        expect(body.objects.count).toBe(2000);
        expect(body.objects.first).toEqual({
          index: 0,
          value: "row-0",
          active: true,
        });
        expect(body.objects.last).toEqual({
          index: 1999,
          value: "row-1999",
          active: false,
        });
        expect(body.objects.size).toBeGreaterThan(0);
        expect(body.stream.bytes).toBe(1024 * 1024);
        expect(body.stream.checksum).toBe(120 * 64 * 1024);
        for (const ms of [
          body.rootMs,
          body.returnedMs,
          body.bytes.ms,
          body.objects.ms,
          body.stream.ms,
        ]) {
          expect(Number.isFinite(ms)).toBe(true);
          expect(ms).toBeGreaterThanOrEqual(0);
        }
        yield* Console.log(
          `RPC_OBJECT_PERFORMANCE ${JSON.stringify({ mode: dev ? "local" : "live", transport, ...body })}`,
        );
        yield* closed(url, idFor("performance"));
      }),
      options,
    );
  }
});
