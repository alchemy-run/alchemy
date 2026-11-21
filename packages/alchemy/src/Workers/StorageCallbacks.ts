import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import {
  type Callback,
  type CallbackFactory,
  type CallbackRecurrence,
  type CallbackStatus,
  Callbacks,
  nextCallbackRun,
  resolveCallbackSchedule,
} from "../Callback.ts";

/** The key-value storage jobs are kept in, as a Durable Object's. */
export interface CallbackStorage {
  get<T>(key: string): Effect.Effect<T | undefined>;
  put<T>(key: string, value: T): Effect.Effect<void>;
  delete(key: string): Effect.Effect<boolean>;
  list<T>(options: { readonly prefix: string }): Effect.Effect<Map<string, T>>;
}

/** One alarm per instance, as Durable Objects have: setting it replaces it. */
export interface Alarm {
  readonly set: (at: number) => Effect.Effect<void>;
  readonly get: Effect.Effect<number | null>;
}

/** A pending callback job, stored under {@link jobKey}. */
interface CallbackJob {
  /** When it was asked for, kept across retries. */
  readonly scheduledAt: number;
  /** When it runs next: `scheduledAt`, or a retry's time. */
  readonly due: number;
  readonly payload: unknown;
  /** Attempts that failed since it was scheduled. */
  readonly attempts: number;
  /** Replaced by every schedule: a job scheduled again while it ran isn't removed. */
  readonly token: string;
  readonly progress?: number;
  /** How a recurring job repeats; absent for one run. */
  readonly recurrence?: CallbackRecurrence;
}

const JOB_PREFIX = "cb:";
const jobKey = (name: string, id: string) => `${JOB_PREFIX}${encodeURIComponent(name)}:${id}`;
const jobName = (key: string) =>
  decodeURIComponent(key.slice(JOB_PREFIX.length, key.indexOf(":", JOB_PREFIX.length)));

const HOUR = 60 * 60 * 1000;

/**
 * Durable callbacks (`alchemy/Callback`) over an instance's key-value storage
 * and one wake-up, for hosts without a callbacks implementation of their own
 * (Rivet, Effect Cluster, Domain's Durable Object hosts). Jobs are rows in the instance's storage; the alarm
 * is set for the soonest, and `fire` (the instance's alarm handler) runs the
 * due ones. A job whose handler dies is redelivered from 2 seconds doubling,
 * then hourly, and never dropped. Delivery is at least once.
 *
 * Handlers run in Node processes here, not workerd, so `fire` keeps an
 * in-memory flag to run one pass at a time.
 */
export const storageCallbacks = (storage: CallbackStorage, alarm: Alarm) => {
  const handlers = new Map<
    string,
    {
      readonly run: (payload: unknown) => Effect.Effect<unknown>;
    }
  >();
  const arm = (due: number) =>
    Effect.gen(function* () {
      const current = yield* alarm.get;
      if (current === null || due < current) yield* alarm.set(due);
    });
  const token = Effect.map(
    Effect.all([Clock.currentTimeMillis, Random.nextInt]),
    ([now, n]) => `${now.toString(36)}-${(n >>> 0).toString(36)}`,
  );

  const make: CallbackFactory = (name, handler) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      handlers.set(name, {
        // Each invocation gets a fresh Scope.
        run: (payload) =>
          Effect.scoped(handler(payload as never)).pipe(
            Effect.provide(context),
          ) as unknown as Effect.Effect<unknown>,
      });
      const callback: Callback<any> = {
        schedule: (id, scheduled) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const { at: due, recurrence } = yield* resolveCallbackSchedule(name, scheduled, now);
            const key = jobKey(name, id);
            const existing = yield* storage.get<CallbackJob>(key);
            // A replayed schedule can't replace newer work.
            if (
              scheduled.progress !== undefined &&
              existing?.progress !== undefined &&
              scheduled.progress < existing.progress
            )
              return;
            yield* storage.put(key, {
              scheduledAt: due,
              due,
              payload: scheduled.payload,
              attempts: 0,
              token: yield* token,
              progress: scheduled.progress ?? existing?.progress,
              ...(recurrence === undefined ? {} : { recurrence }),
            } satisfies CallbackJob);
            yield* arm(due);
          }),
        cancel: (id) => Effect.asVoid(storage.delete(jobKey(name, id))),
        getStatus: (id) =>
          storage
            .get<CallbackJob>(jobKey(name, id))
            .pipe(
              Effect.map(
                (job): CallbackStatus | undefined =>
                  job && { scheduledAt: job.scheduledAt, progress: job.progress },
              ),
            ),
      };
      return callback;
    });

  let firing = false;
  let again = false;
  const pass = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const jobs = yield* storage.list<CallbackJob>({ prefix: JOB_PREFIX });
    for (const [key, job] of jobs) {
      if (job.due > now) continue;
      const handler = handlers.get(jobName(key));
      // Not registered by this code: keep it for code that registers it.
      if (handler === undefined) continue;
      const exit = yield* Effect.exit(handler.run(job.payload));
      const after = yield* storage.get<CallbackJob>(key);
      // Scheduled again (or cancelled) while it ran: that stands.
      if (after?.token !== job.token) continue;
      if (exit._tag === "Success") {
        if (job.recurrence === undefined) {
          yield* storage.delete(key);
          continue;
        }
        // A recurring job moves to its next run.
        const next = yield* nextCallbackRun(
          jobName(key),
          job.recurrence,
          job.scheduledAt,
          yield* Clock.currentTimeMillis,
        ).pipe(Effect.orDie);
        yield* storage.put(key, { ...job, scheduledAt: next, due: next, attempts: 0 });
        continue;
      }
      const attempts = job.attempts + 1;
      const wait = Math.min(HOUR, 2_000 * 2 ** (attempts - 1));
      yield* Effect.logError(`Callback ${jobName(key)} failed; retrying`, exit.cause);
      yield* storage.put(key, { ...job, attempts, due: (yield* Clock.currentTimeMillis) + wait });
    }
    // Arm the alarm for the soonest job left.
    let next = Infinity;
    for (const job of (yield* storage.list<CallbackJob>({ prefix: JOB_PREFIX })).values())
      next = Math.min(next, job.due);
    if (Number.isFinite(next)) yield* alarm.set(next);
  });
  /** Run every due job, then arm the alarm for the next. The instance's alarm handler. */
  const fire: Effect.Effect<void> = Effect.suspend(() => {
    if (firing) {
      again = true;
      return Effect.void;
    }
    firing = true;
    const loop: Effect.Effect<void> = Effect.suspend(() => {
      again = false;
      return pass.pipe(Effect.andThen(Effect.suspend(() => (again ? loop : Effect.void))));
    });
    return loop.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          firing = false;
        }),
      ),
    );
  });
  return { callbacks: Layer.succeed(Callbacks, { make }), fire };
};
