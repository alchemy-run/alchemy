import {
  isScopeEjected,
  makeRequestEffect,
} from "@/Cloudflare/Workers/HttpServer.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * In-process pin of event scope ownership for streamed bodies. The bridge
 * runs each event under a scope whose finalizers flush telemetry and closes
 * it on return unless it was ejected; `toHandled` opens the request scope
 * beneath it. A streamed body must own both scopes, so the flush runs after
 * the body's finalizers, exactly once, on EOF, failure and cancellation. A
 * HEAD answer and a non-stream body keep the bridge's close-on-return.
 */
const exitKind = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit)
    ? "success"
    : Cause.hasInterruptsOnly(exit.cause)
      ? "interrupt"
      : "failure";

const chunk = (text: string) => new TextEncoder().encode(text);
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
);

const makeEvent = () => {
  const events: string[] = [];
  /** The bridge's per-event scope; its finalizer stands for the exporter flush. */
  const eventScope = Scope.makeUnsafe();
  Effect.runSync(
    Scope.addFinalizer(
      eventScope,
      Effect.sync(() => {
        events.push("event:flush");
      }),
    ),
  );
  /** Released by the test between chunks so the client sets the pace. */
  const gate = Deferred.makeUnsafe<void>();
  /** Released after the client read the second chunk; a failure then reaches it. */
  const failureGate = Deferred.makeUnsafe<void>();

  const handler = (mode: "eof" | "fail" | "cancel" | "plain") =>
    Effect.gen(function* () {
      if (mode === "plain") return HttpServerResponse.text("plain");
      // A request-scoped resource the body keeps using after the handler returned.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          events.push("service:open");
        }),
        (_, exit) =>
          Effect.sync(() => {
            events.push(`service:close:${exitKind(exit)}`);
          }),
      );
      const body = Stream.make(chunk("one")).pipe(
        Stream.concat(
          Stream.fromEffect(Deferred.await(gate)).pipe(
            Stream.flatMap(() =>
              mode === "fail"
                ? Stream.make(chunk("two")).pipe(
                    Stream.concat(
                      Stream.fromEffect(Deferred.await(failureGate)).pipe(
                        Stream.flatMap(() =>
                          Stream.fail(new Error("injected body failure")),
                        ),
                      ),
                    ),
                  )
                : Stream.make(chunk("two")),
            ),
          ),
        ),
        Stream.onExit((exit) =>
          Effect.sync(() => {
            events.push(`source:exit:${exitKind(exit)}`);
          }),
        ),
      );
      return HttpServerResponse.stream(body, {
        headers: { "x-probe": "stream" },
        contentType: "application/x-probe",
        contentLength: 6,
      });
    });

  // `makeRequestEffect` is typed `as any` at its return; pin R to `never`.
  const handle = (
    request: Request,
    mode: "eof" | "fail" | "cancel" | "plain",
  ): Effect.Effect<Response> =>
    (
      makeRequestEffect<never>(request as any, handler(mode)) as Effect.Effect<
        Response,
        never,
        Scope.Scope
      >
    ).pipe(Effect.provideService(Scope.Scope, eventScope));

  /** The bridge's close-on-return: an ejected scope is left to its new owner. */
  const closeOnReturn = () =>
    isScopeEjected(eventScope)
      ? Effect.void
      : Scope.close(eventScope, Exit.void);

  const closes = () =>
    events.filter(
      (event) => event.startsWith("service:close") || event === "event:flush",
    );

  return {
    events,
    eventScope,
    gate,
    failureGate,
    handle,
    closeOnReturn,
    closes,
  };
};

describe("a streamed body owns the event scope", () => {
  for (const mode of ["eof", "fail", "cancel"] as const) {
    it.effect(`flushes after the body's finalizers, once, on ${mode}`, () =>
      Effect.gen(function* () {
        const probe = makeEvent();
        const response = yield* probe.handle(
          new Request("https://worker.test/stream"),
          mode,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-probe")).toBe("stream");
        // The handler returned; the bridge would skip its close-on-return.
        expect(isScopeEjected(probe.eventScope)).toBe(true);
        yield* probe.closeOnReturn();
        yield* settle;
        expect(probe.events).toEqual(["service:open"]);

        const reader = response.body!.getReader();
        const first = yield* Effect.promise(() => reader.read());
        expect(new TextDecoder().decode(first.value)).toBe("one");
        // A slow client: nothing closes while the body waits on the next pull.
        yield* settle;
        expect(probe.closes()).toEqual([]);

        if (mode === "cancel") {
          yield* Effect.promise(() => reader.cancel("client went away"));
        } else {
          yield* Deferred.succeed(probe.gate, undefined);
          const second = yield* Effect.promise(() => reader.read());
          expect(new TextDecoder().decode(second.value)).toBe("two");
          if (mode === "fail") {
            yield* settle;
            expect(probe.closes()).toEqual([]);
            yield* Deferred.succeed(probe.failureGate, undefined);
            const failed = yield* Effect.promise(() =>
              reader.read().then(
                () => "read",
                (error) => String(error),
              ),
            );
            expect(failed).toContain("injected body failure");
          } else {
            const done = yield* Effect.promise(() => reader.read());
            expect(done.done).toBe(true);
          }
        }
        yield* settle;

        const kind =
          mode === "eof"
            ? "success"
            : mode === "fail"
              ? "failure"
              : "interrupt";
        expect(probe.events).toEqual([
          "service:open",
          `source:exit:${kind}`,
          `service:close:${kind}`,
          "event:flush",
        ]);
      }),
    );
  }

  it.effect("a HEAD answer keeps the bridge's close for both scopes", () =>
    Effect.gen(function* () {
      const probe = makeEvent();
      const response = yield* probe.handle(
        new Request("https://worker.test/stream", { method: "HEAD" }),
        "eof",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-probe")).toBe("stream");
      // The GET's content headers survive the dropped body.
      expect(response.headers.get("content-type")).toBe("application/x-probe");
      expect(response.headers.get("content-length")).toBe("6");
      expect(response.body).toBeNull();
      // The request scope closed on return; the event scope is the bridge's.
      expect(isScopeEjected(probe.eventScope)).toBe(false);
      expect(probe.events).toEqual(["service:open", "service:close:success"]);
      yield* probe.closeOnReturn();
      expect(probe.events).toEqual([
        "service:open",
        "service:close:success",
        "event:flush",
      ]);
    }),
  );

  it.effect("a non-stream body keeps the bridge's close-on-return", () =>
    Effect.gen(function* () {
      const probe = makeEvent();
      const response = yield* probe.handle(
        new Request("https://worker.test/plain"),
        "plain",
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe("plain");
      expect(isScopeEjected(probe.eventScope)).toBe(false);
      yield* probe.closeOnReturn();
      expect(probe.events).toEqual(["event:flush"]);
    }),
  );
});
