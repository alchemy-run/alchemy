/**
 * Runs that outlive the instance that accepted them. A harness records a
 * run before it starts, arms a durable callback, and records the result
 * when it ends. An instance that dies in between leaves the record behind,
 * and the callback runs it again on the next instance.
 *
 * A run is identified by an id its caller chooses, so sending it again is
 * the same run: it is not started twice, and its result is returned once it
 * has one.
 *
 * @internal
 * @module
 */
import * as Alchemy from "alchemy";
import type { Callbacks } from "alchemy/Callback";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { InstanceSetup } from "alchemy/Workers/InstanceSetup";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Text by key: where runs are recorded. */
export interface RunStore {
  readonly get: (key: string) => Effect.Effect<string | undefined, unknown, RuntimeContext>;
  readonly put: (key: string, value: string) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly delete: (key: string) => Effect.Effect<void, unknown, RuntimeContext>;
}

/** Where a run stands. */
export type RunStatus<A> =
  | { readonly status: "running" }
  | { readonly status: "done"; readonly value: A }
  | { readonly status: "failed"; readonly message: string };

/** A run could not be recorded or read. */
export class RunsError extends Schema.TaggedError<RunsError>()("RunsError", {
  message: Schema.String,
}) {}

const Record = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literals(["running", "done", "failed"]),
    /** What the run was given: kept until it ends, so another instance can run it. */
    payload: Schema.optional(Schema.Unknown),
    /** How many times the run has been started. */
    attempts: Schema.Number,
    value: Schema.optional(Schema.Unknown),
    message: Schema.optional(Schema.String),
  }),
);
type Record = (typeof Record)["Type"];

export interface RunsOptions<Payload, A> {
  /** Names the callback: unique among the harnesses of one instance. */
  readonly name: string;
  readonly store: RunStore;
  /**
   * The durable callbacks of an instance that can be evicted. Without
   * them, a run that loses its instance stays unfinished until it is sent
   * again.
   */
  readonly callbacks?: Layer.Layer<Callbacks>;
  /**
   * Do the run. `attempt` is 1 the first time and counts every start since:
   * a later attempt follows one an instance did not live to finish. A
   * failure is the run's result; a defect or an interruption is not, and
   * the run is started again.
   */
  readonly execute: (
    payload: Payload,
    run: { readonly id: string; readonly attempt: number },
  ) => Effect.Effect<A, { readonly message: string }, RuntimeContext>;
  /**
   * Starts before a run is given up on.
   * @default 3
   */
  readonly maxAttempts?: number;
}

export interface Runs<Payload, A> {
  /**
   * Record the run, do it now and return how it ended. A run already
   * recorded under `id` is not started again: its result is returned, or
   * awaited when this instance is still doing it.
   */
  readonly run: (
    id: string,
    payload: Payload,
  ) => Effect.Effect<RunStatus<A>, RunsError, RuntimeContext>;
  /**
   * Record the run and return: the instance's callback does it. Needs
   * `callbacks`; without them the run is done before this returns.
   */
  readonly submit: (id: string, payload: Payload) => Effect.Effect<void, RunsError, RuntimeContext>;
  /** Where the run stands, or `undefined` when no run has that id. */
  readonly status: (
    id: string,
  ) => Effect.Effect<RunStatus<A> | undefined, RunsError, RuntimeContext>;
}

/** How long after a run starts its callback checks on it. */
const CHECK_AFTER = "30 seconds";

const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

const failed = (cause: unknown) => RunsError.make({ message: messageOf(cause) });

/**
 * Runs for the instance yielding the harness. Yield it where the harness
 * is (a Durable Object's outer Effect): the callback registers itself when
 * the instance starts.
 */
export const makeRuns = <Payload, A>(
  options: RunsOptions<Payload, A>,
): Effect.Effect<Runs<Payload, A>> =>
  Effect.gen(function* () {
    const { store } = options;
    const maxAttempts = options.maxAttempts ?? 3;
    const key = (id: string) => `run:${id}`;
    const read = (id: string) =>
      store.get(key(id)).pipe(
        Effect.flatMap((text) =>
          text === undefined ? Effect.succeed(undefined) : Schema.decodeEffect(Record)(text),
        ),
        Effect.mapError(failed),
      );
    const write = (id: string, record: Record) =>
      Schema.encodeEffect(Record)(record).pipe(
        Effect.flatMap((text) => store.put(key(id), text)),
        Effect.mapError(failed),
      );
    const statusOf = (record: Record): RunStatus<A> =>
      record.status === "done"
        ? { status: "done", value: record.value as A }
        : record.status === "failed"
          ? { status: "failed", message: record.message ?? "" }
          : { status: "running" };

    /** The runs this instance is doing now. */
    const inFlight = new Map<string, Deferred.Deferred<RunStatus<A>, RunsError>>();
    let wake: Alchemy.Callback<{ readonly id: string }> | undefined;

    /** Start a recorded run, record how it ended, and return that. */
    const start = (id: string, payload: Payload, record: Record | undefined) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<RunStatus<A>, RunsError>();
        inFlight.set(id, done);
        const attempt = (record?.attempts ?? 0) + 1;
        const exit = yield* write(id, { status: "running", payload, attempts: attempt }).pipe(
          Effect.andThen(
            wake === undefined
              ? Effect.void
              : wake
                  .schedule(`check:${id}`, { after: CHECK_AFTER, payload: { id } })
                  .pipe(Effect.mapError(failed)),
          ),
          Effect.andThen(
            options.execute(payload, { id, attempt }).pipe(
              Effect.matchEffect({
                onSuccess: (value) =>
                  Effect.as(write(id, { status: "done", attempts: attempt, value }), {
                    status: "done" as const,
                    value,
                  }),
                onFailure: (failure) =>
                  Effect.as(
                    write(id, { status: "failed", attempts: attempt, message: failure.message }),
                    { status: "failed" as const, message: failure.message },
                  ),
              }),
            ),
          ),
          Effect.tap(() =>
            wake === undefined ? Effect.void : Effect.ignore(wake.cancel(`check:${id}`)),
          ),
          Effect.exit,
        );
        inFlight.delete(id);
        // A defect leaves the record running: the callback starts it again.
        yield* Deferred.done(
          done,
          Exit.isSuccess(exit)
            ? exit
            : Exit.fail(RunsError.make({ message: exit.cause.pipe(Cause.squash, messageOf) })),
        );
        return yield* exit;
      });

    const run = (id: string, payload: Payload) =>
      Effect.gen(function* () {
        const mine = inFlight.get(id);
        if (mine !== undefined) return yield* Deferred.await(mine);
        const record = yield* read(id);
        if (record !== undefined && record.status !== "running") return statusOf(record);
        // Recorded as running and not ours: the instance that started it is gone.
        return yield* start(id, (record?.payload as Payload | undefined) ?? payload, record);
      });

    const callbacks = options.callbacks;
    const setup = yield* Effect.serviceOption(InstanceSetup);
    if (callbacks !== undefined && Option.isSome(setup)) {
      setup.value.add(
        Effect.gen(function* () {
          const handler = Effect.fn(function* ({ id }: { readonly id: string }) {
            const record = yield* read(id);
            if (record === undefined || record.status !== "running") return;
            if (inFlight.has(id)) {
              // Still being done here: look again later, in case this instance dies first.
              if (wake !== undefined) {
                yield* wake.schedule(`check:${id}`, { after: CHECK_AFTER, payload: { id } });
              }
              return;
            }
            if (record.attempts >= maxAttempts) {
              yield* write(id, {
                status: "failed",
                attempts: record.attempts,
                message: `Given up after ${record.attempts} attempts that did not finish.`,
              });
              return;
            }
            yield* start(id, record.payload as Payload, record);
            // A failed check is a defect, which the callbacks redeliver.
          }, Effect.orDie);
          wake = yield* Alchemy.makeCallback(`ai:runs:${options.name}`, handler).pipe(
            Effect.provide(callbacks),
          );
        }),
      );
    }

    return {
      run,
      submit: (id, payload) =>
        Effect.gen(function* () {
          if (wake === undefined) return yield* Effect.asVoid(run(id, payload));
          if (inFlight.has(id) || (yield* read(id)) !== undefined) return;
          yield* write(id, { status: "running", payload, attempts: 0 });
          yield* wake.schedule(id, { after: 0, payload: { id } }).pipe(Effect.mapError(failed));
        }),
      status: (id) =>
        Effect.map(read(id), (record) => (record === undefined ? undefined : statusOf(record))),
    };
  });

/** A run store that lasts as long as the process. */
export const memoryRunStore = (): RunStore => {
  const values = new Map<string, string>();
  return {
    get: (key) => Effect.sync(() => values.get(key)),
    put: (key, value) => Effect.sync(() => void values.set(key, value)),
    delete: (key) => Effect.sync(() => void values.delete(key)),
  };
};
