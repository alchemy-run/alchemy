import type { WorkerEvent } from "@/Cloudflare/Workers/WorkerRuntime.ts";
import { makeWorkerRuntimeContext } from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const runDispatch = <A>([program, services]: readonly [
  Effect.Effect<A>,
  Context.Context<never>,
]) => program.pipe(Effect.provide(services));

class TestService extends Context.Service<TestService, string>()(
  "WorkerRuntimeContext.test/TestService",
) {}

describe("WorkerRuntimeContext", () => {
  it.effect("dispatches a queue event to every matching listener", () =>
    Effect.gen(function* () {
      const ctx = makeWorkerRuntimeContext("queue-listeners");
      const observed: string[] = [];
      let applicationCalls = 0;
      yield* ctx.serve(
        Effect.sync(() => {
          applicationCalls++;
          return HttpServerResponse.text("application");
        }),
      );
      yield* ctx.listen((event) => {
        if (event.type !== "queue") return;
        return Effect.sync(() => {
          observed.push("first");
          return "first result";
        });
      });
      yield* ctx.listen((event) => {
        if (event.type !== "queue") return;
        return Effect.sync(() => {
          observed.push("second");
          return "second result";
        });
      });
      const exports = yield* ctx.exports;
      const result = yield* runDispatch<string>(
        exports.default.queue(
          { queue: "queue-a", messages: [] },
          {},
          {} as ExecutionContext,
        ),
      );
      expect(observed).toEqual(["first", "second"]);
      expect(result).toBe("second result");
      expect(applicationCalls).toBe(0);
    }),
  );

  it.effect(
    "matched fetch skips the application even when serve was registered first",
    () =>
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("matched-fetch");
        let applicationCalls = 0;
        yield* ctx.serve(
          Effect.sync(() => {
            applicationCalls++;
            return HttpServerResponse.text("application");
          }),
        );
        yield* ctx.listen((event) => {
          if (event.type !== "fetch") return;
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
        const response = yield* runDispatch<Response>(
          exports.default.fetch(request, {}, {} as ExecutionContext),
        );
        expect(response.status).toBe(202);
        expect(yield* Effect.promise(() => response.text())).toBe(
          "signed body",
        );
        expect(applicationCalls).toBe(0);
      }),
  );

  it.effect(
    "unmatched fetch preserves the application request and response",
    () =>
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("unmatched-fetch");
        let listenerCalls = 0;
        yield* ctx.listen((event) => {
          if (event.type !== "fetch") return;
          if (new URL((event.input as Request).url).pathname !== "/hook")
            return;
          return Effect.sync(() => {
            listenerCalls++;
            return new Response(null, { status: 401 });
          });
        });
        yield* ctx.serve<never>(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            expect(request.method).toBe("POST");
            expect(request.headers["x-request"]).toBe("preserved");
            return HttpServerResponse.text(yield* request.text, {
              status: 201,
              headers: { "x-application": "preserved" },
            });
          }),
        );
        const exports = yield* ctx.exports;
        const request = new Request("https://worker.example/application", {
          method: "POST",
          headers: { "x-request": "preserved" },
          body: "application body",
        });
        const response = yield* runDispatch<Response>(
          exports.default.fetch(request, {}, {} as ExecutionContext),
        );
        expect(response.status).toBe(201);
        expect(response.headers.get("x-application")).toBe("preserved");
        expect(yield* Effect.promise(() => response.text())).toBe(
          "application body",
        );
        expect(listenerCalls).toBe(0);
      }),
  );

  it.effect("serves a webhook without an application handler", () =>
    Effect.gen(function* () {
      const ctx = makeWorkerRuntimeContext("webhook-only");
      yield* ctx.listen((event) => {
        if (event.type !== "fetch") return;
        if (new URL((event.input as Request).url).pathname !== "/hook") return;
        return Effect.succeed(new Response("webhook", { status: 202 }));
      });
      const exports = yield* ctx.exports;
      const response = yield* runDispatch<Response>(
        exports.default.fetch(
          new Request("https://worker.example/hook"),
          {},
          {} as ExecutionContext,
        ),
      );
      expect(response.status).toBe(202);
      expect(yield* Effect.promise(() => response.text())).toBe("webhook");
      const exit = yield* runDispatch<Response>(
        exports.default.fetch(
          new Request("https://worker.example/unmatched"),
          {},
          {} as ExecutionContext,
        ),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toEqual(
          new Error("No event handler found for event type 'fetch'"),
        );
      }
    }),
  );

  it.effect(
    "executes every matching fetch listener and returns the first response",
    () =>
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("multiple-fetch-listeners");
        const observed: string[] = [];
        let applicationCalls = 0;
        yield* ctx.serve(
          Effect.sync(() => {
            applicationCalls++;
            return HttpServerResponse.text("application");
          }),
        );
        yield* ctx.listen((event) => {
          if (event.type !== "fetch") return;
          return Effect.sync(() => {
            observed.push("observer");
          });
        });
        for (const name of ["first", "second"]) {
          yield* ctx.listen((event) => {
            if (event.type !== "fetch") return;
            return Effect.sync(() => {
              observed.push(name);
              return new Response(name);
            });
          });
        }
        const exports = yield* ctx.exports;
        const response = yield* runDispatch<Response>(
          exports.default.fetch(
            new Request("https://worker.example/hook"),
            {},
            {} as ExecutionContext,
          ),
        );
        expect(observed).toEqual(["observer", "first", "second"]);
        expect(yield* Effect.promise(() => response.text())).toBe("first");
        expect(applicationCalls).toBe(0);
      }),
  );

  it.effect(
    "resolves effectful listeners at export time and retains their services",
    () =>
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("effectful-listener");
        let initialized = false;
        let applicationCalls = 0;
        yield* ctx.serve(
          Effect.sync(() => {
            applicationCalls++;
            return HttpServerResponse.text("application");
          }),
        );
        yield* ctx
          .listen(
            Effect.gen(function* () {
              yield* Effect.yieldNow;
              const prefix = yield* TestService;
              initialized = true;
              return (event: WorkerEvent) => {
                if (event.type !== "fetch") return;
                return Effect.gen(function* () {
                  const suffix = yield* TestService;
                  return new Response(`${prefix}:${suffix}`);
                });
              };
            }),
          )
          .pipe(Effect.provideService(TestService, "registration"));
        expect(initialized).toBe(false);
        const exports = yield* ctx.exports.pipe(
          Effect.provideService(TestService, "exports"),
        );
        expect(initialized).toBe(true);
        const response = yield* runDispatch<Response>(
          exports.default.fetch(
            new Request("https://worker.example/hook"),
            {},
            {} as ExecutionContext,
          ),
        );
        expect(yield* Effect.promise(() => response.text())).toBe(
          "exports:exports",
        );
        expect(applicationCalls).toBe(0);
      }),
  );

  it.effect("retains the application shape and exported service context", () =>
    Effect.gen(function* () {
      const ctx = makeWorkerRuntimeContext("application-shape");
      const shape = {
        greet: () => TestService.pipe(Effect.map((name) => `hello ${name}`)),
      };
      yield* ctx
        .serve(
          shape
            .greet()
            .pipe(Effect.map((body) => HttpServerResponse.text(body))),
          { shape },
        )
        .pipe(Effect.provideService(TestService, "registration"));
      expect(ctx.shape()).toBe(shape);
      const exports = yield* ctx.exports.pipe(
        Effect.provideService(TestService, "exports"),
      );
      const dispatched = exports.default.fetch(
        new Request("https://worker.example/application"),
        {},
        {} as ExecutionContext,
      );
      const response = yield* runDispatch<Response>(dispatched);
      expect(yield* Effect.promise(() => response.text())).toBe(
        "hello exports",
      );
      const rpcResult = yield* (
        ctx.shape().greet() as Effect.Effect<string, never, TestService>
      ).pipe(Effect.provide(dispatched[1] as Context.Context<TestService>));
      expect(rpcResult).toBe("hello exports");
    }),
  );

  it.effect("listener failure does not fall back to the application", () =>
    Effect.gen(function* () {
      const ctx = makeWorkerRuntimeContext("failed-listener");
      let applicationCalls = 0;
      yield* ctx.serve(
        Effect.sync(() => {
          applicationCalls++;
          return HttpServerResponse.text("application");
        }),
      );
      const failure = new Error("webhook failed");
      yield* ctx.listen((event) => {
        if (event.type !== "fetch") return;
        return Effect.die(failure);
      });
      const exports = yield* ctx.exports;
      const exit = yield* runDispatch<Response>(
        exports.default.fetch(
          new Request("https://worker.example/hook"),
          {},
          {} as ExecutionContext,
        ),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBe(failure);
      }
      expect(applicationCalls).toBe(0);
    }),
  );

  it.effect(
    "does not use the application for an unmatched non-fetch event",
    () =>
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("unmatched-queue");
        let applicationCalls = 0;
        yield* ctx.serve(
          Effect.sync(() => {
            applicationCalls++;
            return HttpServerResponse.text("application");
          }),
        );
        const exports = yield* ctx.exports;
        const exit = yield* runDispatch<void>(
          exports.default.queue(
            { queue: "queue-a", messages: [] },
            {},
            {} as ExecutionContext,
          ),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toEqual(
            new Error("No event handler found for event type 'queue'"),
          );
        }
        expect(applicationCalls).toBe(0);
      }),
  );
});
