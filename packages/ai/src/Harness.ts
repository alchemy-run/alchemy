import type { RuntimeContext } from "alchemy/RuntimeContext";
import { InstanceSetup } from "alchemy/Workers/InstanceSetup";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { AnyModel } from "./Model.ts";
import type { HistoryOptions, SessionEvent, SessionPage } from "./Session.ts";

export {
  HistoryOptions,
  QueuedMessage,
  SessionEntry,
  SessionEvent,
  SessionItem,
  SessionPage,
} from "./Session.ts";

/** A harness could not run what a process asked of it. */
export class HarnessError extends Data.TaggedError("HarnessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The answer to one message. */
export interface Reply {
  /** The text of the answer. */
  readonly text: string;
}

/** What a message is sent with. */
export interface SendOptions {
  /**
   * Makes the message exactly-once: a retry with the same id, from this
   * instance or a later one, is not run again.
   */
  readonly requestId?: string;
  /** The model that answers from now on. It must be one the process mentions, or the default. */
  readonly model?: AnyModel;
}

/** What a harness runs a session with. */
export interface EngineSessionOptions {
  /** The process's prose, as the model reads it. */
  readonly instructions: string;
  /** Every tool the session may call. */
  readonly tools: ReadonlyArray<unknown>;
  /** The model a new session starts on. */
  readonly model: AnyModel;
}

/** One session, as a harness runs it. */
export interface EngineSession {
  /** Whether the harness has the session. */
  readonly exists: Effect.Effect<boolean, HarnessError, RuntimeContext>;
  /**
   * Make the session if the harness does not have it, without giving it a
   * message. Gives the id its tool calls carry (`AI.ToolCall`'s
   * `conversationId`).
   */
  readonly open: (options?: {
    readonly model?: AnyModel;
  }) => Effect.Effect<string, HarnessError, RuntimeContext>;
  /** Store a message and return without waiting for the answer. It runs after what is running. */
  readonly send: (
    text: string,
    options?: SendOptions,
  ) => Effect.Effect<void, HarnessError, RuntimeContext>;
  /**
   * Store a message for the turn that is running to read at its next step.
   * With nothing running it starts a turn, as `send` does.
   */
  readonly steer: (
    text: string,
    options?: Pick<SendOptions, "requestId">,
  ) => Effect.Effect<void, HarnessError, RuntimeContext>;
  /** Take back a queued message, by its `QueuedMessage` id. Does nothing once it was read. */
  readonly withdraw: (id: string) => Effect.Effect<void, HarnessError, RuntimeContext>;
  /** Send a message and wait for the answer. */
  readonly prompt: (
    text: string,
    options?: SendOptions,
  ) => Effect.Effect<Reply, HarnessError, RuntimeContext>;
  /** Stop the turn that is running. Queued messages stay queued. */
  readonly interrupt: Effect.Effect<void, HarnessError, RuntimeContext>;
  /** The session's status, then every item after `after`, then what happens next. */
  readonly events: (options?: {
    readonly after?: number;
  }) => Stream.Stream<SessionEvent, HarnessError, RuntimeContext>;
  /** A page of the stored items. */
  readonly history: (
    options?: HistoryOptions,
  ) => Effect.Effect<SessionPage, HarnessError, RuntimeContext>;
}

/** Small values kept beside the sessions, in the same storage. */
export interface EngineValues {
  readonly get: (key: string) => Effect.Effect<string | undefined, HarnessError, RuntimeContext>;
  readonly put: (key: string, value: string) => Effect.Effect<void, HarnessError, RuntimeContext>;
}

/** A harness that is open: the sessions it runs. */
export interface Engine {
  readonly session: (name: string, options: EngineSessionOptions) => EngineSession;
  /** Where a session's own values are kept: who it acts as. The model never reads them. */
  readonly values: EngineValues;
  /** What the model calls a tool on this harness. */
  readonly toolName: (tool: unknown) => string;
}

/** What one process needs its harness to know: its models and tools, and the services behind them. */
export interface Registration {
  readonly models: ReadonlyArray<AnyModel>;
  readonly tools: ReadonlyArray<unknown>;
  readonly context: Context.Context<never>;
}

/**
 * The coding agent that runs processes. A process never names one: provide
 * `Pi.HarnessLive` or `OpenCode.HarnessLive` where the process's other
 * Layers are provided, and every process in that place runs on it.
 *
 * **Example:** Choosing the harness
 * ```typescript
 * export const Live = EngineerLive.pipe(
 *   Layer.provide(
 *     Layer.mergeAll(
 *       Pi.HarnessLive,
 *       PiCloudflare.DurableObjectStorage,
 *       Pi.CodingTools,
 *       AI.DefaultModel(Smart),
 *       SmartLive,
 *     ),
 *   ),
 * );
 * ```
 */
export class Harness extends Context.Service<
  Harness,
  {
    /** The coding agent's name (`pi`, `opencode`). */
    readonly engine: string;
    /** Tell the harness what a process uses. Called while the process's Layer is built. */
    readonly add: (registration: Registration) => Effect.Effect<void>;
    /** The open harness. It opens once, with everything added before then. */
    readonly open: Effect.Effect<Engine, HarnessError, RuntimeContext>;
  }
>()("AI.Harness") {}

/** What a harness opens with: everything its processes use. */
export interface EngineOptions {
  readonly models: ReadonlyArray<AnyModel>;
  readonly tools: ReadonlyArray<unknown>;
}

const unique = <T>(items: ReadonlyArray<T>): ReadonlyArray<T> => [...new Set(items)];

/**
 * Build an `AI.Harness` Layer for a coding agent. `make` is the agent's own
 * harness, yielded once with every model and tool the processes of this
 * place use; it finds their implementations in the services the processes
 * were given.
 *
 * @internal
 */
export const makeHarness = <R>(
  engine: string,
  make: (options: EngineOptions) => Effect.Effect<Engine, never, unknown>,
): Layer.Layer<Harness, never, R> =>
  Layer.effect(
    Harness,
    Effect.gen(function* () {
      const own = yield* Effect.context<never>();
      const registrations: Array<Registration> = [];
      let opened: Engine | undefined;
      let opening: Promise<Engine> | undefined;

      /** Yield the agent's harness, then run the per-instance setup it asked for. */
      const start = Effect.gen(function* () {
        const pending: Array<Effect.Effect<void, never, RuntimeContext>> = [];
        const context = registrations
          .reduce<Context.Context<never>>((all, each) => Context.merge(all, each.context), own)
          .pipe(Context.omit(Scope.Scope));
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the processes' contexts hold what their models and tools need
        const built = yield* make({
          models: unique(registrations.flatMap((each) => each.models)),
          tools: unique(registrations.flatMap((each) => each.tools)),
        }).pipe(
          Effect.provideContext(
            Context.add(context, InstanceSetup, { add: (effect) => void pending.push(effect) }),
          ),
        ) as Effect.Effect<Engine>;
        for (const effect of pending) yield* effect;
        opened = built;
        return built;
      });

      const open = Effect.gen(function* () {
        if (opened !== undefined) return opened;
        if (opening === undefined) {
          const context = yield* Effect.context<RuntimeContext>();
          opening = Effect.runPromiseWith(context)(start);
        }
        return yield* Effect.tryPromise({
          try: () => opening!,
          catch: (cause) =>
            new HarnessError({ message: `The ${engine} harness did not open`, cause }),
        });
      });

      // Where an instance has a setup step (a Durable Object), the harness
      // opens there: after every process registered, before any event.
      const setup = yield* Effect.serviceOption(InstanceSetup);
      if (Option.isSome(setup)) setup.value.add(Effect.ignore(open));

      return {
        engine,
        add: (registration) =>
          Effect.suspend(() => {
            if (opened !== undefined || opening !== undefined) {
              return Effect.die(
                new HarnessError({
                  message:
                    "A process was added after its harness opened. Yield every process where the runtime's dependencies are resolved (a Durable Object's outer Effect).",
                }),
              );
            }
            registrations.push(registration);
            return Effect.void;
          }),
        open,
      };
    }),
  ) as Layer.Layer<Harness, never, R>;

/**
 * Values kept for the life of the instance: what a harness falls back to
 * on storage that has nowhere to keep them.
 *
 * @internal
 */
export const memoryValues = (): EngineValues => {
  const values = new Map<string, string>();
  return {
    get: (key) => Effect.sync(() => values.get(key)),
    put: (key, value) => Effect.sync(() => void values.set(key, value)),
  };
};
