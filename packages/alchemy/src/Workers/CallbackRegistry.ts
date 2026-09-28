import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import {
  CallbackError,
  type Callback,
  type CallbackFactory,
  type CallbackOptions,
  type CallbackScheduleOptions,
} from "../Callback.ts";
import { RuntimeContext } from "../RuntimeContext.ts";

export interface CallbackJob {
  readonly callback: string;
  readonly id: string;
  readonly version: string;
  readonly runAt: number;
  readonly payload: string;
}

type StoreEffect<A = void> = Effect.Effect<A, CallbackError, RuntimeContext>;

/** Native persistence and wake operations; claims and acknowledgements compare versions. */
export interface CallbackStore {
  readonly put: (job: CallbackJob) => StoreEffect;
  readonly remove: (callback: string, id: string) => StoreEffect;
  readonly prepare: (
    hasCallbacks: boolean,
    hasLegacyHandler: boolean,
  ) => StoreEffect<boolean>;
  readonly due: (
    now: number,
    limit: number,
  ) => StoreEffect<readonly CallbackJob[]>;
  readonly claim: (job: CallbackJob, retryAt: number) => StoreEffect<boolean>;
  readonly acknowledge: (job: CallbackJob) => StoreEffect;
  readonly sync: () => StoreEffect;
  readonly reconcile: () => StoreEffect;
}

export interface RegisteredCallback {
  readonly retryDelay: number;
  readonly handler: (
    payload: unknown,
  ) => Effect.Effect<unknown, unknown, RuntimeContext | Scope.Scope>;
}

export interface CallbackRegistry {
  readonly callbacks: Map<string, RegisteredCallback>;
  readonly store: CallbackStore;
  readonly omitContext: (context: Context.Context<any>) => Context.Context<any>;
  open: boolean;
}

export const makeCallbackRegistry = (
  store: CallbackStore,
  omitContext: CallbackRegistry["omitContext"] = (context) => context,
): CallbackRegistry => ({
  callbacks: new Map(),
  store,
  omitContext,
  open: false,
});

/** Registration is allowed only while the inner instance constructor runs. */
export const openCallbackRegistry = (registry: CallbackRegistry) => {
  registry.open = true;
  return () => {
    registry.open = false;
  };
};

export const makeCallbackFactory =
  (registry: CallbackRegistry): CallbackFactory =>
  <Payload, E, R>(
    name: string,
    handler: (payload: Payload) => Effect.Effect<unknown, E, R>,
    options?: CallbackOptions,
  ): Effect.Effect<
    Callback<Payload>,
    never,
    RuntimeContext | Exclude<R, Scope.Scope>
  > =>
    Effect.gen(function* () {
      const context = registry.omitContext(
        (yield* Effect.context<Exclude<R, Scope.Scope>>()).pipe(
          Context.omit(
            RuntimeContext,
            Scope.Scope,
            Tracer.ParentSpan,
            Tracer.Tracer,
            Logger.CurrentLoggers,
          ),
        ),
      );
      if (!registry.open || !name || registry.callbacks.has(name)) {
        return yield* Effect.die(
          new CallbackError({
            callback: name,
            message: !registry.open
              ? "Alarm callbacks must be registered during Durable Object instance initialization"
              : "Alarm callback names must be non-empty and unique within an instance",
          }),
        );
      }
      const retryDelay = yield* Effect.sync(() =>
        Duration.toMillis(options?.retry?.delay ?? "30 seconds"),
      );
      if (!Number.isFinite(retryDelay) || retryDelay <= 0) {
        return yield* Effect.die(
          new CallbackError({
            callback: name,
            message: "Alarm retry delay must be finite and positive",
          }),
        );
      }
      yield* Effect.sync(() =>
        registry.callbacks.set(name, {
          retryDelay,
          handler: (payload) =>
            Effect.gen(function* () {
              const invocation = yield* Effect.context<
                RuntimeContext | Scope.Scope
              >();
              return yield* handler(payload as Payload).pipe(
                Effect.provide(
                  Context.merge(invocation, context) as Context.Context<R>,
                ),
              );
            }),
        }),
      );

      return {
        schedule: Effect.fn(function* (
          id: string,
          schedule: CallbackScheduleOptions<Payload>,
        ) {
          const now = yield* Clock.currentTimeMillis;
          const { at, payload } = yield* Effect.try({
            try: () => {
              if (!id) throw new Error("Alarm IDs must be non-empty");
              if (
                (schedule.at === undefined) ===
                (schedule.after === undefined)
              ) {
                throw new Error("Specify exactly one of at or after");
              }
              const delay =
                schedule.after === undefined
                  ? undefined
                  : Duration.toMillis(schedule.after);
              const at =
                schedule.at === undefined
                  ? now + delay!
                  : schedule.at instanceof Date
                    ? schedule.at.getTime()
                    : schedule.at;
              if (
                !Number.isFinite(at) ||
                at <= 0 ||
                (delay !== undefined && (!Number.isFinite(delay) || delay < 0))
              ) {
                throw new Error(
                  "Alarm time must be finite and delay must be non-negative",
                );
              }
              if (!Schema.is(Schema.Json)(schedule.payload)) {
                throw new Error("Alarm payload must be a JSON value");
              }
              const payload = JSON.stringify(schedule.payload);
              if (payload === undefined)
                throw new Error("Alarm payload must be JSON-serializable");
              return { at, payload };
            },
            catch: (cause) =>
              new CallbackError({
                callback: name,
                message: "Invalid alarm schedule",
                cause,
              }),
          });
          const version = yield* Effect.sync(() => crypto.randomUUID());
          yield* registry.store.put({
            callback: name,
            id,
            version,
            runAt: at,
            payload,
          });
        }),
        cancel: (id: string) => registry.store.remove(name, id),
      };
    });
