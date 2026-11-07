import * as Move from "alchemy/Workers/Workerd/DurableObjectMove";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import {
  type Forwarded,
  LOCAL,
  dynamic,
  forwardTo,
  legacyStub,
  sourceCalls,
} from "./Forwarding.ts";
import { type Classes, type ObjectImpl, SEALED, parseName } from "./ModelClass.ts";

/**
 * The model class's objects: each runs its route's implementation. A key whose
 * old class is still on the Worker forwards to the old object, which keeps
 * serving, while its alarm copies the old object's storage; then it seals the
 * old object and takes over in one short step (see `DurableObjectMove`).
 */

/** How long one alarm of a new object copies before it schedules the next. */
const COPY_BUDGET_MS = 20_000;

/** An old object that doesn't know the move: it still runs the code from before the deploy. */
const STALE = /not found on Durable Object/;

/** How long an old object on older code is left alone: past the ~10s idle that moves it to new code. */
const STALE_IDLE_MS = 15_000;

/** How long a call waits, at most, for the old object to move to the deployed code. */
const STALE_HOLD_MS = 60_000;

/**
 * The shared class: each object runs its route's implementation. A route
 * whose version 0 class is still on the Worker moves its key's data first:
 * see the module's description.
 */
export const router = (
  routes: Map<string, ObjectImpl>,
  movers: Map<string, string>,
  classes: () => Classes,
): ObjectImpl =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    // At deploy time the class is declared with a placeholder state: no object, no route.
    const parsed = parseName(state.id?.name);
    const impl = parsed === undefined ? undefined : routes.get(parsed.route);
    // At deploy time: nothing to construct.
    if (parsed === undefined) return Effect.succeed({});
    // A route this code doesn't host: the object runs on code from before the
    // deploy that added it (a new view generation's objects are new routes in
    // an existing class, and an object moves to new code only once idle), or
    // after the one that removed it. It keeps its data, and answers every call
    // so that callers try again later, as they do for any object on older code.
    if (impl === undefined)
      return Effect.as(
        Effect.logWarning(
          `domain object ${parsed.route}/${parsed.key} started on code without its route`,
        ),
        undefined,
      ).pipe(
        Effect.andThen(() =>
          Effect.succeed(
            dynamic((prop) =>
              prop === "alarm" || LOCAL.has(prop)
                ? () => Effect.void
                : prop === "fetch"
                  ? Effect.succeed(
                      HttpServerResponse.text(`${parsed.route} isn't in the code this runs yet`, {
                        status: 503,
                      }),
                    )
                  : () => Effect.die(new Error(`${parsed.route} isn't in the code this runs yet`)),
            ),
          ),
        ),
      );
    const inner = yield* impl;
    const from = movers.has(parsed.route)
      ? legacyStub(classes(), parsed.route, parsed.key, state.id.jurisdiction)
      : undefined;
    return Effect.gen(function* () {
      // Built now, while the object is constructed, as always: it reads its
      // storage lazily, so it serves the copied data once the move is done.
      const instance = yield* inner;
      const raw = state.raw.storage;
      const owned = () => from === undefined || Move.moveState(raw)?.phase === "owned";
      if (owned())
        return {
          ...instance,
          domainMove: () => Effect.succeed(true),
          domainMoveState: () => Effect.succeed({ phase: "owned" }),
        };
      const calls = sourceCalls(from!);

      const name = `${parsed.route}/${parsed.key}`;
      /** One step at a time: an alarm and the migration's call never copy at once. */
      let driving = false;
      let failures = 0;
      let lastError: string | undefined;
      /**
       * Until when the old object is left alone: it still runs the code from
       * before the deploy (Cloudflare moves an object to new code only once
       * it has been idle for about ten seconds), and every call would keep it
       * there. Calls to this key wait meanwhile, rather than keep it busy.
       */
      let staleUntil = 0;
      /**
       * Copy for up to `budget`; once caught up, take over with this object's
       * own calls held. A failure never stops the move: it logs, and the alarm
       * tries again later, waiting longer each time (Cloudflare's own alarm
       * retries give up after a few).
       */
      const step = (budget: number) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // Checked and claimed at once: an alarm and a call never both start a step.
          const start = yield* Effect.sync(() => {
            if (driving || owned() || now < staleUntil) return false;
            driving = true;
            return true;
          });
          if (!start) return;
          yield* Effect.gen(function* () {
            yield* Move.begin(raw, calls);
            const ready = yield* Move.copyFor(raw, calls, budget);
            yield* Effect.logDebug(
              `domain move ${name} ${JSON.stringify(Move.moveState(raw))} ready=${ready}`,
            );
            if (ready)
              yield* state
                .blockConcurrencyWhile(() => Effect.exit(Move.takeOver(raw, calls)))
                .pipe(Effect.flatten);
            failures = 0;
            // Not done: carry on in the next alarm.
            if (!owned()) {
              const now = yield* Clock.currentTimeMillis;
              yield* Effect.promise(() => raw.setAlarm(now));
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                failures += 1;
                lastError = Cause.pretty(cause).slice(0, 2000);
                if (STALE.test(lastError)) {
                  // On older code: leave it idle long enough to move to the deployed code.
                  staleUntil = (yield* Clock.currentTimeMillis) + STALE_IDLE_MS;
                  yield* Effect.promise(() => raw.setAlarm(staleUntil + 100));
                  return;
                }
                yield* Effect.logWarning(`domain move ${name} failed (${failures})`, cause);
                const wait = Math.min(30_000, 250 * 2 ** Math.min(failures, 7));
                const now = yield* Clock.currentTimeMillis;
                yield* Effect.promise(() => raw.setAlarm(now + wait));
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                driving = false;
              }),
            ),
          );
        });

      /**
       * While the old object is left alone, wait; then start the move here (the
       * old object now runs the deployed code, or is left alone again). Bounded:
       * past {@link STALE_HOLD_MS} a call goes to the old object anyway.
       */
      const holdWhileStale = Effect.gen(function* () {
        const until = (yield* Clock.currentTimeMillis) + STALE_HOLD_MS;
        let now = yield* Clock.currentTimeMillis;
        while (!owned() && now < staleUntil && now < until) {
          yield* Effect.sleep("250 millis");
          now = yield* Clock.currentTimeMillis;
          if (now >= staleUntil) yield* step(0);
        }
      });

      /** Make sure something drives the move: a pending alarm, or a step under way. */
      const ensureDriven = Effect.gen(function* () {
        if (driving || owned()) return;
        if ((yield* Effect.promise(() => raw.getAlarm())) === null) {
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.promise(() => raw.setAlarm(now));
        }
      });

      // Start the move as soon as the object is first used: its alarm drives it.
      yield* ensureDriven;

      const forwarded = Effect.succeed(from);
      return dynamic((prop) => {
        // Where the move has got to: for tests and operators.
        if (prop === "domainMoveState")
          return () =>
            Effect.sync(() => ({
              ...(owned() ? { phase: "owned" } : (Move.moveState(raw) ?? { phase: "none" })),
              driving,
              failures,
              ...(lastError === undefined ? {} : { lastError }),
            }));
        if (owned()) {
          if (prop === "domainMove") return () => Effect.succeed(true);
          return (instance as Record<string, unknown>)[prop];
        }
        switch (prop) {
          case Move.OwnsAlarmCallbacks:
            return true;
          case "alarm":
            return () => step(COPY_BUDGET_MS);
          // The migration's call: answer once the move is done or `waitMillis`
          // passes. The alarm does the copying, in an invocation of its own: run
          // here, its calls would nest under the migration's, and Cloudflare
          // limits how deep calls within a Worker go.
          case "domainMove":
            return (waitMillis: number) =>
              Effect.gen(function* () {
                const until = (yield* Clock.currentTimeMillis) + waitMillis;
                while (!owned() && (yield* Clock.currentTimeMillis) < until) {
                  yield* ensureDriven;
                  yield* Effect.sleep("100 millis");
                }
                return owned();
              });
          default: {
            if (LOCAL.has(prop)) return undefined;
            // Every call makes sure the move is driven (a stalled one restarts),
            // and waits while the old object is left to move to the deployed code.
            const before = Effect.andThen(ensureDriven, holdWhileStale);
            /** Serve here: the old object is sealed, so finish taking over first. */
            const serveHere = (use: (member: unknown) => Effect.Effect<unknown>) =>
              Effect.gen(function* () {
                yield* step(COPY_BUDGET_MS);
                if (!owned())
                  return yield* Effect.die(
                    new Error(`${name} is still taking over from its old object; try again`),
                  );
                return yield* use((instance as Record<string, unknown>)[prop]);
              });
            if (prop === "fetch")
              // A sealed old object forwards to this one: never forward back.
              return Effect.andThen(
                before,
                Move.moveState(raw)?.phase === "seal"
                  ? serveHere((member) => member as Effect.Effect<unknown>)
                  : (forwardTo(forwarded, prop) as Effect.Effect<unknown>),
              );
            // Until the move is done, the old object serves: it holds the data. A sealed
            // one refuses (it would forward back here, and each call would bounce until
            // Cloudflare's depth limit), and this object takes over and serves instead.
            return (...args: ReadonlyArray<unknown>) =>
              Effect.andThen(
                before,
                Effect.gen(function* () {
                  if (Move.moveState(raw)?.phase === "seal")
                    return yield* serveHere((member) =>
                      (member as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
                    );
                  const answer = yield* from!.domainForward!(prop, args).pipe(
                    Effect.map((value): Forwarded => ({ value })),
                    Effect.catchCause((cause): Effect.Effect<Forwarded, unknown> => {
                      const text = Cause.pretty(cause);
                      if (text.includes(SEALED)) return Effect.succeed({ sealed: true } as const);
                      // Code from before the deploy has no `domainForward`, and never forwards back.
                      if (STALE.test(text)) return Effect.succeed({ stale: true } as const);
                      return Effect.failCause(cause);
                    }),
                  );
                  if ("value" in answer) return answer.value;
                  if ("stale" in answer) return yield* from![prop]!(...args);
                  return yield* serveHere((member) =>
                    (member as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
                  );
                }),
              );
          }
        }
      });
    });
  });
