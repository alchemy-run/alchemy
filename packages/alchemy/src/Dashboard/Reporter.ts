import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import { Cli } from "../Cli/Cli.ts";
import * as Discovery from "./Discovery.ts";
import { toPlanJson } from "./PlanJson.ts";

/**
 * Decorate a Cli layer so every apply session is *also* streamed to a
 * running `alchemy dashboard` in the same project (see Discovery). The
 * inner Cli (InkCLI / LoggingCli) keeps rendering the terminal exactly as
 * before — the dashboard is an additional observer, plugged in through the
 * same `Cli` seam.
 *
 * Robustness invariants:
 * - no dashboard running → pure pass-through (single ~250ms probe per apply)
 * - posts are serialized through a queue (event order is preserved) and
 *   every failure is swallowed — a dashboard can never fail or stall a
 *   deploy
 * - `done()` flushes the queue with a hard 3s budget
 */
export const withDashboardReporter = <E, R>(
  cli: Layer.Layer<Cli, E, R>,
): Layer.Layer<Cli, E, R | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Cli,
    Effect.gen(function* () {
      const inner = yield* Cli;
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path
      >();

      const post = (url: string, body: unknown) =>
        Effect.tryPromise(() =>
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(2000),
          }),
        ).pipe(Effect.ignore);

      return Cli.of({
        approvePlan: inner.approvePlan,
        displayPlan: inner.displayPlan,
        startApplySession: Effect.fn(function* (plan) {
          const session = yield* inner.startApplySession(plan);
          const ad = yield* Discovery.discover().pipe(
            Effect.provideContext(context),
            Effect.orElseSucceed(() => undefined),
          );
          if (ad === undefined) {
            return session;
          }

          const sessionId = `${process.pid}-${Date.now().toString(36)}`;
          yield* post(`${ad.url}/api/apply/start`, {
            sessionId,
            plan: toPlanJson(plan),
          });

          type Item = { path: string; body: unknown } | "flush";
          const queue = yield* Queue.unbounded<Item>();
          const flushed = yield* Deferred.make<void>();
          yield* Effect.forkDetach(
            Effect.gen(function* () {
              while (true) {
                const item = yield* Queue.take(queue);
                if (item === "flush") {
                  break;
                }
                yield* post(`${ad.url}${item.path}`, item.body);
              }
              yield* Deferred.succeed(flushed, undefined);
            }).pipe(Effect.ignore),
          );

          let seq = 0;
          return {
            emit: (event) =>
              session.emit(event).pipe(
                Effect.tap(() =>
                  Queue.offer(queue, {
                    path: "/api/apply/event",
                    body: { sessionId, seq: seq++, event },
                  }).pipe(Effect.ignore),
                ),
              ),
            done: (outcome) =>
              Effect.gen(function* () {
                yield* Queue.offer(queue, {
                  path: "/api/apply/done",
                  body: { sessionId, outcome },
                }).pipe(Effect.ignore);
                yield* Queue.offer(queue, "flush").pipe(Effect.ignore);
                yield* session.done(outcome);
                yield* Deferred.await(flushed).pipe(
                  Effect.timeout(Duration.seconds(3)),
                  Effect.ignore,
                );
              }),
          };
        }),
      });
    }),
  ).pipe(Layer.provide(cli)) as any;
