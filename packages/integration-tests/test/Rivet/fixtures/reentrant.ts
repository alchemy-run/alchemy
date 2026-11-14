/**
 * Calls that could deadlock: a transaction, or the constructor, waiting on
 * a call back into its own instance (directly or through another
 * instance), a transaction waiting on a call that needs storage, work
 * that outlives a transaction, and alarms that fail or run longer than
 * RivetKit lets an action run.
 *
 * Every method reports how the work it ran ended, measured inside the
 * instance, so a defect a transaction dies with is visible to the test.
 */
import * as Rivet from "@alchemy.run/rivet";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Default } from "./cluster.ts";
import { Reentrant, type Outcome } from "./reentrant-declaration.ts";

const describeCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause) as { _tag?: unknown; status?: unknown } | undefined;
  if (typeof error !== "object" || error === null) return String(error);
  const tag = typeof error._tag === "string" ? error._tag : String(error);
  return error.status === undefined ? tag : `${tag} ${error.status}`;
};

const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Outcome, never, R> =>
  Effect.gen(function* () {
    const start = yield* Effect.sync(() => Date.now());
    const exit = yield* Effect.exit(effect);
    const ms = (yield* Effect.sync(() => Date.now())) - start;
    return Exit.isSuccess(exit)
      ? { ok: true, ms }
      : { ok: false, error: describeCause(exit.cause), ms };
  });

// A call that would deadlock today hangs: give up on it, so a broken
// instance reports instead of wedging the test.
const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.timeoutOrElse(effect, {
    duration: "45 seconds",
    orElse: () => Effect.die(new Error("hung")),
  });

export const ReentrantLive = Reentrant.make(
  { main: import.meta.url, handler: "ReentrantLive" },
  Effect.gen(function* () {
    const selves = yield* Reentrant;
    return Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      const name = state.id.name;
      const self = selves.getByName(name);
      const read = (key: string) =>
        Effect.map(state.storage.get<number>(key), (value) => value ?? 0);
      const bump = (key: string) =>
        Effect.gen(function* () {
          const next = (yield* read(key)) + 1;
          yield* state.storage.put(key, next);
          return next;
        });

      // An instance addressed as `ctor-…` calls itself while it's being
      // constructed: the call can't run until construction finishes.
      const constructed: Outcome | undefined = name.startsWith("ctor-")
        ? yield* outcome(bounded(self.ping()))
        : undefined;

      const released = yield* Deferred.make<void>();

      return {
        ping: (): Effect.Effect<string> => Effect.succeed("pong"),
        read: (key: string) => read(key),
        touch: (): Effect.Effect<number, never, RuntimeContext> => bump("touched"),
        // Forward a touch to `target`, from another instance.
        forward: (target: string) => selves.getByName(target).touch(),
        constructed: () => Effect.succeed(constructed ?? null),
        // A transaction that calls back into its own instance, whose call
        // needs storage the transaction holds.
        selfCallInTransaction: () =>
          outcome(
            bounded(
              state.storage.transaction(
                Effect.gen(function* () {
                  yield* state.storage.put("tx", 1);
                  yield* self.touch();
                }),
              ),
            ),
          ),
        // The same, through `peer`, which calls back here.
        peerCallInTransaction: (peer: string) =>
          outcome(
            bounded(
              state.storage.transaction(
                Effect.gen(function* () {
                  yield* state.storage.put("tx", 1);
                  yield* selves.getByName(peer).forward(name);
                }),
              ),
            ),
          ),
        // A call back in that needs no storage runs fine.
        selfPingInTransaction: () =>
          outcome(
            bounded(
              state.storage.transaction(
                Effect.gen(function* () {
                  yield* state.storage.put("tx", 1);
                  yield* self.ping();
                }),
              ),
            ),
          ),
        // Outside a transaction, a call back in that needs storage runs fine.
        selfCallOutsideTransaction: () =>
          outcome(
            bounded(
              Effect.gen(function* () {
                yield* bump("outside");
                yield* self.touch();
              }),
            ),
          ),
        // A transaction that waits for `release`, which needs storage first.
        awaitReleaseInTransaction: () =>
          outcome(
            bounded(
              state.storage.transaction(
                Effect.gen(function* () {
                  yield* state.storage.put("tx", 1);
                  yield* Deferred.await(released);
                }),
              ),
            ),
          ),
        release: () =>
          outcome(
            bounded(
              Effect.gen(function* () {
                yield* bump("released");
                yield* Deferred.succeed(released, undefined);
              }),
            ),
          ),
        // A transaction that runs past its timeout, then writes.
        writeAfterTimeout: () =>
          outcome(
            bounded(
              state.storage.transaction(
                Effect.gen(function* () {
                  yield* Effect.sleep("3 seconds");
                  yield* state.storage.put("late", 1);
                }),
                { timeout: "1 second" },
              ),
            ),
          ),
        // Work a transaction starts that outlives it.
        outliveTransaction: () =>
          outcome(
            bounded(
              state.storage.transaction(
                Effect.gen(function* () {
                  yield* state.storage.put("tx", 1);
                  yield* state.waitUntil(
                    Effect.andThen(Effect.sleep("300 millis"), bump("waited")),
                  );
                  yield* Effect.forkDetach(
                    Effect.andThen(Effect.sleep("300 millis"), bump("forked")),
                  );
                }),
              ),
            ),
          ),
        // An alarm whose handler fails `failures` times, then succeeds.
        armFlakyAlarm: (failures: number) =>
          Effect.gen(function* () {
            yield* state.storage.put("mode", "flaky");
            yield* state.storage.put("failures", failures);
            yield* state.storage.setAlarm((yield* Effect.sync(() => Date.now())) + 100);
          }),
        // An alarm whose handler runs longer than RivetKit lets an action run.
        armSlowAlarm: () =>
          Effect.gen(function* () {
            yield* state.storage.put("mode", "slow");
            yield* state.storage.setAlarm((yield* Effect.sync(() => Date.now())) + 100);
          }),
        alarmState: () =>
          Effect.gen(function* () {
            return {
              runs: yield* read("runs"),
              done: yield* read("done"),
              alarm: yield* state.storage.getAlarm(),
            };
          }),
        alarm: () =>
          Effect.gen(function* () {
            yield* bump("runs");
            const mode = yield* state.storage.get<string>("mode");
            if (mode === "slow") yield* Effect.sleep("70 seconds");
            if (mode === "flaky") {
              const failures = yield* read("failures");
              if (failures > 0) {
                yield* state.storage.put("failures", failures - 1);
                return yield* Effect.die(new Error("flaky alarm"));
              }
            }
            yield* bump("done");
          }),
      };
    });
  }).pipe(Effect.provide(Default)),
);
