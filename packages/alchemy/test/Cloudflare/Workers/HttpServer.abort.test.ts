import { makeRequestEffect } from "@/Cloudflare/Workers/HttpServer.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * In-process pin of request abort propagation: `makeRequestEffect`
 * subscribes to `request.signal`, interrupts the handler when it fires and
 * answers the abort through the failure boundary as 499. The handler's
 * resources see the interruption instead of running to completion for a
 * client that went away.
 */
const exitKind = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit)
    ? "success"
    : Cause.hasInterruptsOnly(exit.cause)
      ? "interrupt"
      : "failure";

const makeProbe = () => {
  const events: string[] = [];
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  /** A provider call that stays open until the test releases it. */
  const handler = Effect.acquireUseRelease(
    Effect.sync(() => {
      events.push("call:open");
    }),
    () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    (_, exit) =>
      Effect.sync(() => {
        events.push(`call:close:${exitKind(exit)}`);
      }),
  ).pipe(
    Effect.andThen(
      Effect.sync(() => {
        events.push("handler:completed");
        return HttpServerResponse.text("done");
      }),
    ),
  );
  // `makeRequestEffect` is typed `as any` at its return; pin R to `never`.
  const handle = (request: Request): Effect.Effect<Response> =>
    makeRequestEffect<never>(request as any, handler);
  return { events, started, release, handle };
};

describe("makeRequestEffect propagates a client abort", () => {
  it.effect("interrupts an in-flight handler and answers 499", () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const controller = new AbortController();
      const answer = yield* Effect.forkChild(
        probe.handle(
          new Request("https://worker.test/slow", {
            signal: controller.signal,
          }),
        ),
      );
      yield* Deferred.await(probe.started);
      expect(probe.events).toEqual(["call:open"]);

      // The runtime fires the signal from outside any fiber; a macrotask
      // keeps the abort on that path instead of inside this fiber's run.
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              controller.abort("client went away");
              resolve();
            }, 0),
          ),
      );
      const response = yield* Fiber.join(answer);
      expect(response.status).toBe(499);
      expect(probe.events).toEqual(["call:open", "call:close:interrupt"]);
    }),
  );

  it.effect("never starts the handler of a request that arrives aborted", () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const controller = new AbortController();
      controller.abort("client went away");
      const response = yield* probe.handle(
        new Request("https://worker.test/slow", { signal: controller.signal }),
      );
      expect(response.status).toBe(499);
      expect(probe.events).toEqual([]);
    }),
  );

  it.effect("leaves a settled handler and its streamed body alone", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const body = Stream.make("one", "two").pipe(
        Stream.map((text) => new TextEncoder().encode(text)),
      );
      const handle: Effect.Effect<Response> = makeRequestEffect<never>(
        new Request("https://worker.test/stream", {
          signal: controller.signal,
        }) as any,
        Effect.succeed(HttpServerResponse.stream(body)),
      );
      const response = yield* handle;
      expect(response.status).toBe(200);
      // The subscription ended with the handler: the abort is not an
      // interruption of the body, which the client can still drain.
      controller.abort("client went away");
      const text = yield* Effect.promise(() => response.text());
      expect(text).toBe("onetwo");
    }),
  );

  it.effect("answers a completed handler normally", () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const answer = yield* Effect.forkChild(
        probe.handle(new Request("https://worker.test/slow")),
      );
      yield* Deferred.await(probe.started);
      yield* Deferred.succeed(probe.release, undefined);
      const response = yield* Fiber.join(answer);
      expect(response.status).toBe(200);
      expect(probe.events).toEqual([
        "call:open",
        "call:close:success",
        "handler:completed",
      ]);
    }),
  );
});
