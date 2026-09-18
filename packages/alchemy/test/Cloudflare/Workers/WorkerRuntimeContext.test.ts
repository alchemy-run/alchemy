import { makeWorkerRuntimeContext } from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";
import { describe, expect, it } from "alchemy-test";

describe("WorkerRuntimeContext", () => {
  it.effect("dispatches an event to every listener for that event type", () =>
    Effect.gen(function* () {
      const ctx = makeWorkerRuntimeContext("test-worker");
      const observed: string[] = [];
      yield* ctx.listen((event) => {
        if (event.type !== "queue") return;
        return Effect.sync(() => {
          observed.push("first");
        });
      });
      yield* ctx.listen((event) => {
        if (event.type !== "queue") return;
        return Effect.sync(() => {
          observed.push("second");
        });
      });
      const exports = yield* ctx.exports;
      const [program, services] = exports.default.queue(
        { queue: "queue-a", messages: [] },
        {},
        {} as ExecutionContext,
      );
      yield* (program as Effect.Effect<void>).pipe(
        Effect.provide(services as Context.Context<never>),
      );
      expect(observed).toEqual(["first", "second"]);
    }),
  );

  it.effect(
    "claimed fetch requests never execute the application listener",
    () =>
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("claimed-fetch");
        let applicationCalls = 0;
        yield* ctx.listen(() =>
          Effect.sync(() => {
            applicationCalls++;
          }).pipe(Effect.andThen(Effect.never)),
        );
        yield* ctx.listenFetch((event) => {
          const request = event.input as Request;
          if (new URL(request.url).pathname !== "/hook") return;
          return Effect.promise(() => request.text()).pipe(
            Effect.map((body) => new Response(body, { status: 202 })),
          );
        });
        const exports = yield* ctx.exports;
        const request = new Request("https://worker.example/hook", {
          method: "POST",
          body: "signed body",
        });
        const [program, services] = exports.default.fetch(
          request,
          {},
          {} as ExecutionContext,
        );
        const response = yield* (program as Effect.Effect<Response>).pipe(
          Effect.provide(services as Context.Context<never>),
          Effect.timeout("100 millis"),
        );
        expect(response.status).toBe(202);
        expect(yield* Effect.promise(() => response.text())).toBe(
          "signed body",
        );
        expect(applicationCalls).toBe(0);
      }),
  );

  it.effect(
    "unclaimed fetch requests preserve the application body and response",
    () =>
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("unclaimed-fetch");
        yield* ctx.listenFetch((event) => {
          if (new URL((event.input as Request).url).pathname !== "/hook")
            return;
          return Effect.succeed(new Response(null, { status: 401 }));
        });
        yield* ctx.listen((event) => {
          if (event.type !== "fetch") return;
          return Effect.promise(() => (event.input as Request).text()).pipe(
            Effect.map((body) => new Response(body)),
          );
        });
        const exports = yield* ctx.exports;
        const request = new Request("https://worker.example/application", {
          method: "POST",
          body: "application body",
        });
        const [program, services] = exports.default.fetch(
          request,
          {},
          {} as ExecutionContext,
        );
        const response = yield* (program as Effect.Effect<Response>).pipe(
          Effect.provide(services as Context.Context<never>),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe(
          "application body",
        );
      }),
  );
});
