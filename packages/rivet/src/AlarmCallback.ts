/**
 * Durable callbacks (`alchemy/Callback`) over a Rivet Durable Object's KV
 * storage and its one alarm. Jobs are rows in storage; the alarm is set for
 * the soonest, and {@link AlarmCallbacks.fire} (the instance's `alarm`
 * handler) runs the due ones. Delivery is at least once.
 *
 * Rivet has no Workerd `AlarmCallback`, so Effect Workflow and Domain hosts
 * wire this into `RuntimeContext.makeCallback` per instance.
 *
 * @internal
 */
import type { Callback, CallbackFactory, CallbackOptions, CallbackStatus } from "alchemy/Callback";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import type { DurableObjectStorage } from "./DurableObjectState.ts";

/** One alarm per instance: setting it replaces it. */
export interface Alarm {
  readonly set: (at: number) => Effect.Effect<void>;
  readonly get: Effect.Effect<number | null>;
}

/** A pending callback job. */
interface CallbackJob {
  readonly scheduledAt: number;
  readonly due: number;
  readonly payload: unknown;
  readonly attempts: number;
  readonly token: string;
  readonly progress?: number;
}

const JOB_PREFIX = "cb:";
const jobKey = (name: string, id: string) => `${JOB_PREFIX}${encodeURIComponent(name)}:${id}`;
const jobName = (key: string) =>
  decodeURIComponent(key.slice(JOB_PREFIX.length, key.indexOf(":", JOB_PREFIX.length)));

const HOUR = 60 * 60 * 1000;

/** Storage surface {@link alarmCallbacks} needs. */
export type CallbackStorage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;

export interface AlarmCallbacks {
  readonly makeCallback: CallbackFactory;
  /** Run every due job, then arm the alarm for the next. */
  readonly fire: Effect.Effect<void>;
}

/**
 * Build a `makeCallback` factory and its `fire` handler over an instance's
 * storage and alarm.
 */
export const alarmCallbacks = (storage: CallbackStorage, alarm: Alarm): AlarmCallbacks => {
  const handlers = new Map<
    string,
    {
      readonly run: (payload: unknown) => Effect.Effect<unknown, unknown>;
      readonly options: CallbackOptions | undefined;
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

  const makeCallback: CallbackFactory = (name, handler, options) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      handlers.set(name, {
        run: (payload) =>
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the handler's services are the ones it was registered with
          Effect.scoped(handler(payload as never)).pipe(Effect.provide(context)) as Effect.Effect<
            unknown,
            unknown
          >,
        options,
      });
      const callback: Callback<any> = {
        schedule: (id, scheduled) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const due =
              scheduled.at !== undefined
                ? typeof scheduled.at === "number"
                  ? scheduled.at
                  : scheduled.at.getTime()
                : now + Duration.toMillis(Duration.fromInputUnsafe(scheduled.after));
            const key = jobKey(name, id);
            const existing = yield* storage.get<CallbackJob>(key);
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
            } satisfies CallbackJob);
            yield* arm(due);
          }),
        cancel: (id) => Effect.asVoid(storage.delete(jobKey(name, id))),
        getStatus: (id) =>
          storage.get<CallbackJob>(jobKey(name, id)).pipe(
            Effect.map((job): CallbackStatus | undefined => {
              if (job === undefined) return undefined;
              const max = options?.retry?.maxAttempts ?? 8;
              return {
                scheduledAt: job.scheduledAt,
                retryAt: job.attempts > 0 ? job.due : undefined,
                attempts: Math.min(job.attempts, max),
                parked: job.attempts >= max,
                progress: job.progress,
              };
            }),
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
      if (handler === undefined) continue;
      const exit = yield* Effect.exit(handler.run(job.payload));
      const after = yield* storage.get<CallbackJob>(key);
      if (after?.token !== job.token) continue;
      if (exit._tag === "Success") {
        yield* storage.delete(key);
        continue;
      }
      const retry = handler.options?.retry;
      const delay = Math.max(
        1_000,
        Duration.toMillis(Duration.fromInputUnsafe(retry?.delay ?? "30 seconds")),
      );
      const parked = Math.max(
        HOUR,
        delay,
        Duration.toMillis(Duration.fromInputUnsafe(retry?.parkedDelay ?? 0)),
      );
      const attempts = job.attempts + 1;
      const wait =
        attempts >= (retry?.maxAttempts ?? 8)
          ? parked
          : Math.min(parked, delay * 2 ** (attempts - 1));
      yield* Effect.logError(`Callback ${jobName(key)} failed; retrying`, exit.cause);
      yield* storage.put(key, { ...job, attempts, due: (yield* Clock.currentTimeMillis) + wait });
    }
    let next = Infinity;
    for (const job of (yield* storage.list<CallbackJob>({ prefix: JOB_PREFIX })).values())
      next = Math.min(next, job.due);
    if (Number.isFinite(next)) yield* alarm.set(next);
  });

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

  return { makeCallback, fire };
};
