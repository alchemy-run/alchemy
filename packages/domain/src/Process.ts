/**
 * An `AI.Process` as a member of a model. The platform hosts each of its
 * sessions as an object of its own, and the model records what each session
 * reports: a view named after the process, keyed by the session, whose state
 * is where the session stands and whose events carry its transcript.
 *
 * Nothing here imports `@alchemy.run/ai`: a process is an object with a
 * well-known key, which says how to serve a session, how to read what it
 * reports, and the schemas of a transcript item and a queued message.
 *
 * @module
 */
import { Callbacks, makeCallback, type Callback } from "alchemy/Callback";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { InstanceSetup } from "alchemy/Workers/InstanceSetup";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as AggregateModule from "./Aggregate.ts";
import * as CommandModule from "./Command.ts";
import * as EventModule from "./Event.ts";
import type { Json, ProcessKit } from "./Platform.ts";
import * as ViewModule from "./View.ts";

/** The key under which a process says how a model hosts it. */
export const HostedTypeId = "~alchemy/AI/Hosted" as const;

/** How a session's reports reach whoever keeps them. */
export interface Sink {
  /** The last numbered report that was kept. */
  readonly cursor: Effect.Effect<number, unknown, RuntimeContext>;
  /** Keep these reports, in order. One already kept is dropped. */
  readonly write: (reports: ReadonlyArray<unknown>) => Effect.Effect<void, unknown, RuntimeContext>;
}

/** How code outside a session's object reaches it. */
export interface Remote {
  /** Call one of the methods `serve` returned, on the object of the session `key`. */
  readonly call: (
    key: string,
    method: string,
    ...args: ReadonlyArray<Json>
  ) => Effect.Effect<Json, never, RuntimeContext>;
}

/** How a model hosts a process: what the process itself knows of its sessions. */
export interface Hosted<
  Item extends Schema.Top = Schema.Top,
  Queued extends Schema.Top = Schema.Top,
> {
  readonly name: string;
  /** The methods, among those `serve` returns, after which a session may have something to report. */
  readonly mutating: ReadonlyArray<string>;
  /** What a session reports, as schemas: one transcript item, and one queued message. */
  readonly reports: { readonly item: Item; readonly queued: Queued };
  /** One session's methods over the process as its Layer built it: JSON in, JSON out. */
  readonly serve: (
    service: unknown,
    key: string,
  ) => Readonly<
    Record<string, (...args: ReadonlyArray<any>) => Effect.Effect<Json, never, RuntimeContext>>
  >;
  /**
   * Hand a session's reports to `sink`. `live` follows the session for as
   * long as it runs. `catchUp` hands over what was stored and not kept, and
   * says whether the session is done: idle, with nothing queued.
   */
  readonly record: (
    service: unknown,
    key: string,
    sink: Sink,
  ) => {
    readonly live: Effect.Effect<void, unknown, RuntimeContext>;
    readonly catchUp: Effect.Effect<boolean, unknown, RuntimeContext>;
  };
  /** The process's client over its sessions' objects. `local` is the process as this code built it. */
  readonly client: (remote: Remote, local: () => unknown) => unknown;
}

/**
 * Structural constraint satisfied by an `AI.Process` declared by name
 * (`class Triage extends AI.Process<Triage>()("Triage", {}) {}`).
 */
export interface Any extends Context.Key<any, any> {
  readonly processName: string;
  readonly [HostedTypeId]: Hosted;
}

/** Whether a value is a process a model can host. */
export const isProcess = (u: unknown): u is Any =>
  (typeof u === "object" || typeof u === "function") && u !== null && HostedTypeId in u;

/** The service a process's Layer provides, and the model provides its client as. */
export type Identifier<P> = P extends Context.Key<infer I, any> ? I : never;

/** Whether a session is working on a turn. */
export const Status = Schema.Literals(["idle", "working"]);
/** Whether a session is working on a turn. */
export type Status = typeof Status.Type;

/** The fields of what a session reports since the last record. */
type ReportedFields<Item extends Schema.Top, Queued extends Schema.Top> = {
  readonly status: typeof Status;
  readonly queued: Schema.$Array<Queued>;
  readonly items: Schema.$Array<
    Schema.Struct<{ readonly seq: typeof Schema.Number; readonly item: Item }>
  >;
};
/** The state of the aggregate that records a process's sessions. */
type SessionState<Queued extends Schema.Top> = Schema.Struct<{
  readonly seq: typeof Schema.Number;
  readonly status: typeof Status;
  readonly queued: Schema.$Array<Queued>;
}>;
/** The state of the view named after a process. */
type StandsState<Queued extends Schema.Top> = Schema.Struct<{
  readonly status: typeof Status;
  readonly queued: Schema.$Array<Queued>;
}>;

/** What a session did since the last record: where it stands, and the transcript items it stored. */
export type Activity<
  Name extends string,
  Item extends Schema.Top,
  Queued extends Schema.Top,
> = EventModule.EventClass<`${Name}Activity`, ReportedFields<Item, Queued>>;

/** The command a session's object records with. */
export type RecordActivity<
  Name extends string,
  Item extends Schema.Top,
  Queued extends Schema.Top,
> = ReturnType<
  typeof CommandModule.make<
    `Record${Name}Activity`,
    { readonly sessionId: typeof Schema.String } & ReportedFields<Item, Queued>,
    readonly [],
    readonly [Activity<Name, Item, Queued>]
  >
>;

/** The aggregate with one instance per session of a process, whose id is the session's key. */
export type Sessions<
  Name extends string,
  Item extends Schema.Top,
  Queued extends Schema.Top,
> = AggregateModule.AggregateClass<
  `${Name}Sessions`,
  AggregateModule.Resolved<
    typeof Schema.String,
    SessionState<Queued>,
    readonly [RecordActivity<Name, Item, Queued>]
  >
>;

/** The view named after a process: where each session stands, with its transcript in its events. */
export type SessionView<
  Name extends string,
  Item extends Schema.Top,
  Queued extends Schema.Top,
> = ViewModule.ViewClass<
  Name,
  ViewModule.Definition<
    readonly [Sessions<Name, Item, Queued>],
    Sessions<Name, Item, Queued>,
    StandsState<Queued>,
    readonly [],
    {}
  >,
  StandsState<Queued>,
  StandsState<Queued>["Type"],
  Sessions<Name, Item, Queued>,
  {},
  Activity<Name, Item, Queued>["Type"]
>;

/** What a model records of a process. */
export interface Recording<
  Name extends string,
  Item extends Schema.Top,
  Queued extends Schema.Top,
> {
  readonly activity: Activity<Name, Item, Queued>;
  readonly record: RecordActivity<Name, Item, Queued>;
  readonly sessions: Sessions<Name, Item, Queued>;
  readonly view: SessionView<Name, Item, Queued>;
}

/**
 * What a model records of a process: an aggregate with one instance per
 * session, the command a session's object records with, the event it
 * records, and the view named after the process that serves it.
 */
const recording = <const Name extends string, Item extends Schema.Top, Queued extends Schema.Top>(
  name: Name,
  item: Item,
  queued: Queued,
): Recording<Name, Item, Queued> => {
  const Entry = Schema.Struct({ seq: Schema.Number, item });
  const reported = {
    status: Status,
    queued: Schema.Array(queued),
    /** The transcript items stored since the last record, in order. */
    items: Schema.Array(Entry),
  };
  /** What a session did since the last record: where it stands, and the items it stored. */
  const Activity = EventModule.make(`${name}Activity` as `${Name}Activity`, reported);
  /** Sent by the object that runs the session, with a batch of what it reported. */
  const Record = CommandModule.make(`Record${name}Activity` as `Record${Name}Activity`, {
    input: { sessionId: Schema.String, ...reported },
    events: [Activity],
  });
  const SessionState = Schema.Struct({
    /** The last item recorded. */
    seq: Schema.Number,
    status: Status,
    queued: Schema.Array(queued),
  });
  type Recorded = {
    readonly seq: number;
    readonly status: Status;
    readonly queued: ReadonlyArray<{ readonly id: string }>;
  };
  type Reported = Omit<Recorded, "seq"> & {
    readonly items: ReadonlyArray<{ readonly seq: number }>;
  };
  const sameQueue = (a: Recorded["queued"], b: Recorded["queued"]) =>
    a.length === b.length && a.every((message, index) => message.id === b[index]!.id);
  const Sessions = AggregateModule.make<
    `${Name}Sessions`,
    typeof Schema.String,
    typeof SessionState,
    readonly [typeof Record]
  >(
    `${name}Sessions` as `${Name}Sessions`,
    {
      id: Schema.String,
      state: SessionState,
      initial: { seq: 0, status: "idle", queued: [] },
      commands: [Record],
      keyOf: (command: { readonly sessionId: string }) => command.sessionId,
      decide: {
        // Items already recorded are dropped, so a batch sent again changes nothing.
        [Record.tag]: (session: Recorded, command: Reported) => {
          const items = command.items.filter((entry) => entry.seq > session.seq);
          const changed =
            command.status !== session.status || !sameQueue(command.queued, session.queued);
          return items.length === 0 && !changed
            ? []
            : [Activity.make({ status: command.status, queued: command.queued, items } as never)];
        },
      },
      evolve: {
        [Activity.tag]: (session: Recorded, event: Reported) => ({
          seq: event.items.at(-1)?.seq ?? session.seq,
          status: event.status,
          queued: event.queued,
        }),
      },
    } as never,
  );
  const ViewState = Schema.Struct({ status: Status, queued: Schema.Array(queued) });
  const SessionView = ViewModule.make<
    Name,
    readonly [typeof Sessions],
    typeof Sessions,
    typeof ViewState
  >(name, {
    from: [Sessions],
    key: Sessions,
    state: ViewState,
    initial: { status: "idle", queued: [] },
    evolve: {
      [Activity.tag]: (_: unknown, event: Reported) => ({
        status: event.status,
        queued: event.queued,
      }),
    },
  } as never);
  return { activity: Activity, record: Record, sessions: Sessions, view: SessionView } as never;
};

/** The schema of one transcript item of a process's sessions. */
export type ItemOf<P extends Any> = P[typeof HostedTypeId]["reports"]["item"];
/** The schema of one queued message of a process's sessions. */
export type QueuedOf<P extends Any> = P[typeof HostedTypeId]["reports"]["queued"];

/** What a model records of the process `P`. */
export type RecordingOf<P extends Any> = Recording<P["processName"], ItemOf<P>, QueuedOf<P>>;
/** The view named after the process `P`: where each session stands, and its transcript. */
export type ViewOf<P> = P extends Any
  ? SessionView<P["processName"], ItemOf<P>, QueuedOf<P>>
  : never;
/** The aggregate that records the sessions of the process `P`. */
export type SessionsOf<P> = P extends Any
  ? Sessions<P["processName"], ItemOf<P>, QueuedOf<P>>
  : never;
/** The event the process `P`'s view carries: what a session did since the last record. */
export type ActivityOf<P> = P extends Any
  ? Activity<P["processName"], ItemOf<P>, QueuedOf<P>>["Type"]
  : never;
/** The state of the process `P`'s view: where a session stands. */
export type StandsOf<P> = P extends Any ? StandsState<QueuedOf<P>>["Type"] : never;

const recordings = new WeakMap<object, unknown>();

/** What a model records of a process: made once, so every model and view shares it. */
export const recordingOf = <P extends Any>(process: P): RecordingOf<P> => {
  let made = recordings.get(process);
  if (made === undefined) {
    const { item, queued } = process[HostedTypeId].reports;
    recordings.set(process, (made = recording(process.processName, item, queued)));
  }
  return made as RecordingOf<P>;
};

/** What a session reports, as a process hands it over. */
type Report =
  | { readonly type: "status"; readonly status: Status; readonly queued: ReadonlyArray<unknown> }
  | { readonly type: "item"; readonly seq: number; readonly item: unknown };

/** What the sessions aggregate's client is used for here. */
interface SessionsClient {
  readonly get: (ref: unknown) => Effect.Effect<{
    readonly seq: number;
    readonly status: Status;
    readonly queued: ReadonlyArray<unknown>;
  }>;
  readonly send: (command: unknown) => Effect.Effect<unknown, unknown>;
}

/** How long a session that is not done is left before its reports are looked at again. */
const RECORD_AGAIN = "5 seconds";

/** Keep a session's reports in the aggregate that records it, one batch at a time. */
const sinkOf = (
  process: Any,
  client: SessionsClient,
  key: string,
  lock: Semaphore.Semaphore,
): Sink => {
  const { sessions, record } = recordingOf(process);
  // Where the session stood at the last record: what a batch with no status repeats.
  let stands: { readonly status: Status; readonly queued: ReadonlyArray<unknown> } | undefined;
  const recorded = Effect.tap(client.get(sessions.ref(key)), (session) =>
    Effect.sync(() => {
      stands ??= { status: session.status, queued: session.queued };
    }),
  );
  return {
    cursor: Effect.map(recorded, (session) => session.seq),
    write: (given) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const reports = given as ReadonlyArray<Report>;
          if (stands === undefined) yield* recorded;
          for (const report of reports) {
            if (report.type === "status") stands = { status: report.status, queued: report.queued };
          }
          yield* client.send(
            record.make({
              sessionId: key,
              status: stands?.status ?? "idle",
              queued: stands?.queued ?? [],
              items: reports.flatMap((report) =>
                report.type === "item" ? [{ seq: report.seq, item: report.item }] : [],
              ),
            } as never),
          );
        }),
      ),
  };
};

/**
 * The object of one session: the process as the handlers' Layer builds it,
 * for this instance alone, and the recording of what it reports.
 *
 * @internal
 */
export const kitOf = <A, E, R>(
  process: Any,
  /** The model's handlers: the process's own Layer is among them. */
  handlers: Layer.Layer<A, E, R>,
  /** What the handlers are built with: the model's clients, and what its Layer was given. */
  services: () => Context.Context<never>,
  /** The client of the aggregate that records the process's sessions, as the model provides it. */
  sessions: () => unknown,
): ProcessKit => {
  const hosted = process[HostedTypeId];
  const mutating = new Set(hosted.mutating);
  return {
    name: process.processName,
    instance: Effect.fn(function* ({ background }) {
      const scope = yield* Effect.scope;
      // What the instance itself runs with wins over what the model's Layer was given.
      const ambient = yield* Effect.context<never>();
      const setup: Array<Effect.Effect<void, never, RuntimeContext>> = [];
      // A harness is one per instance, so the Layer is built here, apart from every other build.
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- `services` holds what the handlers require
      const built = yield* Layer.buildWithMemoMap(handlers, Layer.makeMemoMapUnsafe(), scope).pipe(
        Effect.provideContext(
          Context.merge(
            Context.add(services(), InstanceSetup, { add: (effect) => void setup.push(effect) }),
            Context.omit(InstanceSetup)(ambient),
          ),
        ),
        Effect.orDie,
      ) as Effect.Effect<Context.Context<unknown>>;
      // What a library asked to run once the instance exists: a harness opens here.
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- an instance is built inside its runtime
      for (const effect of setup) yield* effect as Effect.Effect<void>;
      const service = Context.getUnsafe(built, process as Context.Key<unknown, unknown>);

      const callbacks = yield* Effect.serviceOption(Callbacks);
      const lock = yield* Semaphore.make(1);
      const client = sessions() as SessionsClient;
      const recorders = new Map<string, ReturnType<Hosted["record"]>>();
      const recorderOf = (key: string) => {
        let recorder = recorders.get(key);
        if (recorder === undefined) {
          recorders.set(
            key,
            (recorder = hosted.record(service, key, sinkOf(process, client, key, lock))),
          );
        }
        return recorder;
      };

      const following = new Set<string>();
      /** Follow the session live, once for as long as this instance lives. */
      const follow = (key: string) =>
        Effect.suspend(() => {
          if (following.has(key)) return Effect.void;
          following.add(key);
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- an instance's background work runs inside its runtime
          const live = recorderOf(key).live.pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => void following.delete(key))),
          ) as Effect.Effect<void>;
          return background(live);
        });

      /**
       * What makes recording durable where an instance can be evicted: a job
       * on its alarm, kept in its storage. It wakes the instance, keeps what
       * was stored meanwhile, and comes back until the session is done.
       */
      let onRecord: Callback<string> | undefined;
      const again = (key: string): Effect.Effect<void, never, RuntimeContext> =>
        onRecord === undefined
          ? Effect.void
          : onRecord.schedule(key, { after: RECORD_AGAIN, payload: key }).pipe(Effect.orDie);
      if (Option.isSome(callbacks)) {
        onRecord = yield* makeCallback(
          `record-${process.processName}`,
          Effect.fn(function* (key: string) {
            yield* follow(key);
            if (!(yield* recorderOf(key).catchUp)) yield* again(key);
          }, Effect.orDie),
        ).pipe(Effect.provideService(Callbacks, callbacks.value));
      }
      /** Record from now until the session is done. */
      const record = (key: string) => Effect.andThen(follow(key), again(key));

      const methods = new Map<string, ReturnType<Hosted["serve"]>>();
      return {
        call: (key, method, args) =>
          Effect.suspend(() => {
            let served = methods.get(key);
            if (served === undefined) methods.set(key, (served = hosted.serve(service, key)));
            const run = served[method];
            if (run === undefined) {
              return Effect.die(new Error(`${process.processName} has no method ${method}`));
            }
            return mutating.has(method)
              ? Effect.tap(run(...args), () => record(key))
              : run(...args);
          }),
      };
    }),
  };
};

/**
 * The process's client as the model provides it: every call goes to the
 * object of the session it names.
 *
 * @internal
 */
export const clientOf = (
  process: Any,
  call: (key: string, method: string, args: ReadonlyArray<Json>) => Effect.Effect<Json>,
  local: () => unknown,
): unknown =>
  process[HostedTypeId].client({ call: (key, method, ...args) => call(key, method, args) }, local);
