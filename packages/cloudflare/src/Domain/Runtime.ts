import type * as Backfill from "@alchemy.run/domain/Backfill";
import { captureContext } from "@alchemy.run/domain/Platform";
import { makeCallback } from "alchemy/Callback";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";

/**
 * Run `effect` with every other event on this instance held back. Durable
 * Objects run each event in its own I/O context, so cross-event in-memory
 * coordination (semaphores, refs, deferreds) is unsafe; the platform's gate
 * is not.
 */
export const exclusively = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const exit = yield* state.blockConcurrencyWhile(() => Effect.exit(effect));
    return yield* exit;
  });

/**
 * What the backfill protocol runs on in one Durable Object: its storage (an
 * exclusive section is one transaction, with every other event held back),
 * and its jobs as durable callbacks. Each step counts as progress, so a long
 * backfill never exhausts a callback's retry budget.
 */
/** How many due backfill jobs one tick runs, and for how long, before it hands over to the next. */
const TICK_RUNS = 64;
const TICK_MILLIS = 5_000;

/** What a runtime needs of a random source: ids for its jobs. */
export interface Random {
  readonly uuidV4: () => Effect.Effect<string>;
}

export const backfillRuntime = (
  random: Random,
  run: (id: string) => Effect.Effect<void, never, DurableObjectState | RuntimeContext>,
) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const context = yield* captureContext<DurableObjectState | RuntimeContext>();
    const provide = <A, E>(
      effect: Effect.Effect<A, E, DurableObjectState | RuntimeContext>,
    ): Effect.Effect<A, E> => Effect.provide(effect, context);
    const storage: Backfill.Storage = {
      get: <A>(key: string) => provide(state.storage.get<A>(key)),
      put: (entries) =>
        provide(
          Object.keys(entries).length === 0
            ? Effect.void
            : state.storage.put(entries as Record<string, unknown>),
        ),
      delete: (keys) =>
        provide(keys.length === 0 ? Effect.void : Effect.asVoid(state.storage.delete([...keys]))),
      list: <A>(options: {
        readonly prefix: string;
        readonly startAfter?: string;
        readonly limit?: number;
      }) =>
        provide(
          state.storage
            .list<A>({
              prefix: options.prefix,
              ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            })
            .pipe(Effect.map((rows) => [...rows.entries()])),
        ),
      exclusive: (effect) =>
        state.storage.transaction(effect).pipe(exclusively, Effect.orDie, provide),
    };
    // Jobs are rows here (`bf:job:<id>` holds when it's due and a token), run by one
    // alarm callback, the tick. A tick runs every due job, and those its jobs schedule
    // at once, until none is left or its budget is spent: scheduling a job writes one
    // row, where a callback of its own writes about ten. The tick's callback is
    // removed only once it returns, so a crash in between runs the tick again; a
    // job's row is removed only if it wasn't scheduled again while it ran.
    const jobKey = (id: string) => `bf:job:${id}`;
    let ticking = false;
    let dirty = false;
    /** The job running now, and the token of its row: that row doesn't count as already scheduled. */
    let current: { readonly id: string; readonly token: string } | undefined;
    const now = Clock.currentTimeMillis;
    // One at a time: the callback is one row, so a later schedule would replace a sooner one.
    const tickLock = yield* Semaphore.make(1);
    /** Make sure a tick fires by `due`. */
    const tickBy = (due: number) =>
      Effect.gen(function* () {
        const pending = yield* state.storage.get<number>("bf:tick");
        if (pending !== undefined && pending <= due) return;
        const at = yield* now;
        // A callback ignores a schedule whose progress isn't past the last one's: count
        // them, rather than use the clock (each event has its own, and they disagree).
        const progress = ((yield* state.storage.get<number>("bf:tick-progress")) ?? 0) + 1;
        yield* callback.schedule("tick", {
          after: `${Math.max(0, due - at)} millis`,
          payload: {},
          progress,
        });
        yield* state.storage.put({ "bf:tick": due, "bf:tick-progress": progress });
      }).pipe(Effect.orDie, tickLock.withPermits(1));
    const tick: Effect.Effect<void, never, DurableObjectState | RuntimeContext> = Effect.gen(
      function* () {
        yield* state.storage.delete("bf:tick");
        ticking = true;
        const started = yield* now;
        let runs = 0;
        while (true) {
          dirty = false;
          const at = yield* now;
          const rows = [
            ...(yield* state.storage.list<{ due: number; token: string }>({
              prefix: "bf:job:",
            })).entries(),
          ];
          const due = rows.filter(([, job]) => job.due <= at);
          const spent = runs >= TICK_RUNS || at - started >= TICK_MILLIS;
          if ((due.length === 0 && !dirty) || spent) {
            ticking = false;
            const next = Math.min(...rows.map(([, job]) => job.due));
            if (Number.isFinite(next)) yield* tickBy(spent ? Math.min(next, at) : next);
            return;
          }
          for (const [key, job] of due) {
            runs += 1;
            current = { id: key.slice("bf:job:".length), token: job.token };
            yield* run(current.id);
            current = undefined;
            const after = yield* state.storage.get<{ due: number; token: string }>(key);
            if (after?.token === job.token) yield* state.storage.delete(key);
          }
        }
      },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          ticking = false;
          current = undefined;
        }),
      ),
    );
    const callback = yield* makeCallback("domain:backfill", (_: unknown) => tick);
    const jobs: Backfill.Jobs = {
      schedule: (id, afterMillis) =>
        provide(
          Effect.gen(function* () {
            const due = (yield* now) + afterMillis;
            const stored = yield* state.storage.get<{ due: number; token: string }>(jobKey(id));
            // The running job's own row is done once it returns; one scheduled while it
            // ran (by a message that arrived meanwhile) still stands.
            const existing =
              stored !== undefined && current?.id === id && stored.token === current.token
                ? undefined
                : stored;
            // The earliest request wins: already due sooner, that run sees this cause too.
            if (existing !== undefined && existing.due <= due) return;
            const token = yield* random.uuidV4();
            yield* state.storage.put(jobKey(id), {
              due: existing !== undefined ? Math.min(existing.due, due) : due,
              token,
            });
            // A running tick picks it up.
            if (ticking) {
              dirty = true;
              return;
            }
            yield* tickBy(due);
          }).pipe(Effect.orDie),
        ),
    };
    return { storage, jobs, provide };
  });
