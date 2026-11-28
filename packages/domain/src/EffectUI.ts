import { Command, Query, Subscription } from "@effect/ui";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Aggregate from "./Aggregate.ts";
import type * as Api from "./Api.ts";
import type * as DomainCommand from "./Command.ts";
import { sendPayload } from "./internal.ts";
import type * as Middleware from "./Middleware.ts";
import type * as Projection from "./Projection.ts";
import type * as DomainQuery from "./Query.ts";
import * as Read from "./Read.ts";
import { nameOf, outputEvents, readRpcs } from "./ReadRpcs.ts";
import type * as DomainStream from "./Stream.ts";
import * as View from "./View.ts";

/**
 * Per-call headers, read when a Command or query runs, never part of its args. Provide it under
 * `layer` (`Bank.layer.pipe(Layer.provide(Headers))`): a query can fetch outside the component that
 * asked for it, so a sibling of `layer` reaches Commands but not every query fetch. On a server
 * render, `get` can read the request (`Effect.serviceOption(HttpServerRequest)`): it runs in the
 * fetch, which runs in the request.
 */
export class CommandHeaders extends Context.Service<
  CommandHeaders,
  {
    readonly get: (name: string) => Effect.Effect<Headers.Input>;
  }
>()("@alchemy.run/domain/EffectUI/CommandHeaders") {}

/**
 * Makes the id of a Command sent without one: a random UUID. Provide another under `layer` to pin
 * ids in a test. An id never lives in a Model, so hydration and history restore cannot repeat one.
 */
export const NewCommandId = Context.Reference<Effect.Effect<string>>(
  "@alchemy.run/domain/EffectUI/NewCommandId",
  { defaultValue: () => Effect.sync(() => SecureRandom.uuidV4Unsafe()) },
);

type Input<C extends DomainCommand.Any> = Omit<C["Type"], "_tag">;
type Reply<C extends DomainCommand.Any> = C["reply"] extends Schema.Top ? C["reply"]["Type"] : void;
type Rejection<C extends DomainCommand.Any> = C["rejects"][number]["Type"];
type Denial<C extends DomainCommand.Any> = C["middleware"][number]["error"]["Type"];

/** One stream a command committed to. */
export type Receipt = Readonly<{ stream: string; version: number }>;

/** A committed command: its id, its reply, the first stream it wrote, and every stream. */
export type Success<C extends DomainCommand.Any> = Readonly<{
  commandId: string;
  reply: Reply<C>;
  receipt: Receipt;
  commits: ReadonlyArray<Receipt>;
}>;

/**
 * A refusal is final. `Unknown` can be sent again with its `commandId`. `TimedOut`, only for a
 * command made with `consistency: "strong"`, means the command committed at `receipt` and a view
 * did not apply it in time.
 */
export type Failure<C extends DomainCommand.Any, Strong extends boolean = false> =
  | Readonly<{ _tag: "Rejected"; commandId: string; rejection: Rejection<C> }>
  | Readonly<{ _tag: "Denied"; commandId: string; error: Denial<C> }>
  | Readonly<{ _tag: "Unknown"; commandId: string }>
  | (Strong extends true
      ? Readonly<{ _tag: "TimedOut"; commandId: string; receipt: Receipt }>
      : never);

type QueryRejection<Q extends DomainQuery.Any> = Aggregate.InstanceOf<
  NonNullable<Q["definition"]["rejects"]>[number]
>;

type QueryRefusal<Q extends DomainQuery.Any> =
  | Readonly<{ _tag: "Rejected"; rejection: QueryRejection<Q> }>
  | Readonly<{ _tag: "Denied"; error: Middleware.Errors<Q["middleware"]> }>
  | Readonly<{ _tag: "Unknown" }>;

/**
 * A query refusal (`Rejected`, `Denied`) is final. `TimedOut` (only for a query with
 * `waitsFor`) means its projections did not reach this client's writes in time; `Unknown` is
 * transport or a defect. Both can be asked again.
 */
export type QueryFailure<Q extends DomainQuery.Any> =
  NonNullable<Q["definition"]["waitsFor"]> extends readonly []
    ? QueryRefusal<Q>
    : QueryRefusal<Q> | Readonly<{ _tag: "TimedOut" }>;

/** Per-call headers, such as an MFA code. Redacted, so the Effect UI message log hides them. */
export type CallHeaders = Redacted.Redacted<Readonly<Record<string, string>>>;

/**
 * The args of one Api command's Command. Leave `commandId` out: the Command makes one and returns
 * it in its success and failure. Pass that id again only to retry an `Unknown` (or `TimedOut`)
 * failure.
 */
export type CommandArgs<C extends DomainCommand.Any> = Readonly<{
  input: Input<C>;
  commandId?: string | undefined;
  headers?: CallHeaders | undefined;
}>;

/** The args of one Api query: its input. Paging and read-your-writes stay out of the cache key. */
export type QueryArgs<Q extends DomainQuery.Any> = Readonly<{
  input: DomainQuery.InputOf<Q>;
}>;

/** The identity of one Api command's Command service. */
export interface CommandService<Name extends string, Tag extends string> {
  readonly "~@alchemy.run/domain/EffectUI/Command": { readonly api: Name; readonly tag: Tag };
}

/** The identity of one Api query's Query service. */
export interface QueryService<Name extends string, Tag extends string> {
  readonly "~@alchemy.run/domain/EffectUI/Query": { readonly api: Name; readonly tag: Tag };
}

/** An Effect UI Command service for one Api command. Its `make` issues an Unmatched Command. */
export type CommandOf<
  A extends Api.Any,
  C extends DomainCommand.Any,
  Strong extends boolean = false,
> = Command.Service<
  CommandService<A["apiName"], C["tag"]>,
  string,
  CommandArgs<C>,
  Schema.Codec<Success<C>, unknown>,
  false,
  Schema.Codec<Failure<C, Strong>, unknown>
>;

type IsPaged<Q extends DomainQuery.Any> =
  NonNullable<Q["definition"]["paged"]> extends true ? true : false;

/** An Effect UI query for one Api query: an infinite query when it is paged. */
export type QueryOf<A extends Api.Any, Q extends DomainQuery.Any> =
  IsPaged<Q> extends true
    ? Query.InfiniteService<
        QueryService<A["apiName"], Q["queryName"]>,
        string,
        Schema.Codec<QueryArgs<Q>, unknown>,
        Schema.Codec<DomainQuery.ResultOf<Q>, unknown>,
        Api.EntryOf<Q>,
        Schema.Codec<string, unknown>,
        Schema.Codec<QueryFailure<Q>, unknown>
      >
    : Query.Service<
        QueryService<A["apiName"], Q["queryName"]>,
        string,
        Schema.Codec<QueryArgs<Q>, unknown>,
        Schema.Codec<DomainQuery.ResultOf<Q>, unknown>,
        Schema.Codec<QueryFailure<Q>, unknown>
      >;

type ReadEntry = View.Any | DomainStream.Any;
type Reads<A extends Api.Any> = Extract<A["serves"][number], ReadEntry>;
type ReadName<V extends ReadEntry> = V extends View.Any
  ? V["viewName"]
  : V extends DomainStream.Any
    ? V["streamName"]
    : never;
type ReadClient<V extends ReadEntry> = V extends View.Any
  ? Api.ViewClient<V>
  : V extends DomainStream.Any
    ? Api.StreamClient<V>
    : never;
type ReadKey<V extends ReadEntry> = Parameters<ReadClient<V>["watch"]>[0];
type StateOf<V extends ReadEntry> = Stream.Success<ReturnType<ReadClient<V>["watch"]>>["state"];
type EntryOf<V extends ReadEntry> = Exclude<
  Stream.Success<ReturnType<ReadClient<V>["events"]>>,
  Read.CaughtUp
>;
type ErrorOf<V extends ReadEntry> = Stream.Error<ReturnType<ReadClient<V>["watch"]>>;
type ViewStateSchema<V extends View.Any> = [NonNullable<V["definition"]["state"]>] extends [never]
  ? typeof Schema.Never
  : Extract<NonNullable<V["definition"]["state"]>, Schema.Top>;
type SnapshotSchemaOf<V extends View.Any> = ReturnType<typeof snapshotSchema<ViewStateSchema<V>>>;

/** A watch snapshot with explicit absence for Effect UI Models. */
export type Snapshot<State> = Readonly<{
  state: Option.Option<NonNullable<State>>;
  cursor: number;
}>;

/** The identity of one Api View's stream query. */
export interface ViewService<Name extends string, Tag extends string> {
  readonly "~@alchemy.run/domain/EffectUI/View": { readonly api: Name; readonly tag: Tag };
}

/** The args of one View's stream query: its read key, the whole cache key. */
export type ViewArgs<V extends View.Any> = Readonly<{ key: ReadKey<V> }>;

type ViewRejection<V extends View.Any> = Aggregate.InstanceOf<
  NonNullable<V["definition"]["rejects"]>[number]
>;

/**
 * A View read failure. `Rejected` (the View's `validate`) and `Denied` (its middleware, such as
 * a session that ended) end the stream. `TimedOut` means the View did not reach this client's
 * writes in time; `Unknown` is transport or a defect. A failure closes the stream. It opens again
 * when the entry is asked for again (a `get`, a new component, a refetch of a stale entry) or
 * after `invalidate`.
 */
export type ViewFailure<V extends View.Any> =
  | Readonly<{ _tag: "Rejected"; rejection: ViewRejection<V> }>
  | Readonly<{
      _tag: "Denied";
      error: Middleware.Errors<NonNullable<V["definition"]["middleware"]>>;
    }>
  | Readonly<{ _tag: "TimedOut" }>
  | Readonly<{ _tag: "Unknown" }>;

/**
 * An Effect UI stream query for one Api View, keyed by the read key. Its first element is the
 * key's snapshot after this client's writes, then each change follows. A server render ships that
 * first element, and every component that reads the key shares one entry and one open stream.
 */
export type ViewQueryOf<A extends Api.Any, V extends View.Any> = Query.StreamService<
  ViewService<A["apiName"], V["viewName"]>,
  string,
  Schema.Codec<ViewArgs<V>, unknown>,
  Schema.Codec<Snapshot<StateOf<V>>, unknown>,
  Schema.Codec<ViewFailure<V>, unknown>
>;

/** Callbacks for live read state. */
export interface WatchOptions<Message, V extends ReadEntry> {
  /** Change it to start the watch again, for example after `onFailure` and a new sign-in. */
  readonly restartKey?: number | undefined;
  /** The snapshot, and the key it is of: a Model that keeps several keys files it under this one. */
  readonly onSnapshot: (snapshot: Snapshot<StateOf<V>>, key: ReadKey<V>) => Message;
  /** A typed read failure, such as a middleware error once the session ends. The watch stops. */
  readonly onFailure: (error: ErrorOf<V>) => Message;
  /** Handle unexpected read defects. Interruption does not call this callback. */
  readonly onDefect: (cause: Cause.Cause<unknown>) => Message;
}

/** Callbacks for a resumable event feed. The app stores the cursor after applying each entry. */
export interface EventsOptions<Message, V extends ReadEntry> {
  /** The last applied `seq`. Read when the Subscription starts; a later value does not restart it. */
  readonly after: Option.Option<number>;
  /** Change it to restart the feed from the current `after`, for example after a failure. */
  readonly restartKey?: number | undefined;
  readonly onEntry: (entry: EntryOf<V>) => Message;
  /** Every stored entry of `key` has been delivered: what follows is live. */
  readonly onCaughtUp: (cursor: number, key: ReadKey<V>) => Message;
  readonly onFailure: (error: ErrorOf<V>) => Message;
  /** Handle unexpected read defects. Interruption does not call this callback. */
  readonly onDefect: (cause: Cause.Cause<unknown>) => Message;
}

/**
 * Subscriptions for one View or Stream. Return them from a component's `subscriptions`. For a
 * View, `watch` is the lower-level form of its stream query: it copies each snapshot into the
 * Model, opens one stream per component, and has no data in a server render. `events` is a feed
 * of messages, not state, so it stays a Subscription.
 */
export interface ReadClientOf<A extends Api.Any, V extends ReadEntry> {
  readonly watch: <Message>(
    key: ReadKey<V>,
    options: WatchOptions<Message, V>,
  ) => Subscription.Subscription<Message, A["Client"]["Identifier"]>;
  readonly events: <Message>(
    key: ReadKey<V>,
    options: EventsOptions<Message, V>,
  ) => Subscription.Subscription<Message, A["Client"]["Identifier"]>;
}

/** A View's snapshot as a Schema, for a Model field or a root prop that seeds the first paint. */
export interface SnapshotOf<V extends View.Any> {
  /** Encodes `{ state, cursor }` with the View's state Schema; `null` state decodes to `None`. */
  readonly SnapshotSchema: SnapshotSchemaOf<V>;
  /** Decode unknown wire data, such as a root prop. A stale Schema gives `None`, not a crash. */
  readonly decodeSnapshot: (data: unknown) => Option.Option<SnapshotSchemaOf<V>["Type"]>;
}

type Views<A extends Api.Any> = Extract<Reads<A>, View.Any>;

type Services<A extends Api.Any> =
  | {
      [C in Api.CommandsOf<A> as C["tag"]]: CommandService<A["apiName"], C["tag"]>;
    }[Api.CommandsOf<A>["tag"]]
  | {
      [Q in Api.QueriesOf<A> as Q["queryName"]]: QueryService<A["apiName"], Q["queryName"]>;
    }[Api.QueriesOf<A>["queryName"]]
  | {
      [V in Views<A> as V["viewName"]]: ViewService<A["apiName"], V["viewName"]>;
    }[Views<A>["viewName"]];

type LayerRequirements<A extends Api.Any> =
  | A["Client"]["Identifier"]
  | {
      [C in Api.CommandsOf<A> as C["tag"]]: Effect.Services<ReturnType<Api.CommandClient<C>>>;
    }[Api.CommandsOf<A>["tag"]];

/** The View stream queries of an Api, by View name. */
export type ViewQueriesOf<A extends Api.Any> = {
  readonly [V in Views<A> as V["viewName"]]: ViewQueryOf<A, V>;
};

/** The query services of an Api, and its View stream queries, as the cache callbacks receive them. */
export type QueriesOf<A extends Api.Any> = {
  readonly [Q in Api.QueriesOf<A> as Q["queryName"]]: QueryOf<A, Q>;
} & ViewQueriesOf<A>;

/** What one command does to the Effect UI query cache. Each callback also gets the queries. */
export interface CommandConfig<A extends Api.Any, C extends DomainCommand.Any> {
  /**
   * `"strong"`: the command answers once every view its events reach applied them, and a slow
   * view fails it with `TimedOut`. Left out, the client's `Domain.DefaultConsistency` decides, and
   * a view timeout is `Unknown`.
   */
  readonly consistency?: DomainCommand.Consistency | undefined;
  /** What a run invalidates. Replaces the default (see `make`). */
  readonly invalidates?:
    | ((args: CommandArgs<C>, queries: QueriesOf<A>) => ReadonlyArray<Query.Target>)
    | undefined;
  /** Optimistic patches, applied while the run is queued or running. */
  readonly optimistic?:
    | ((args: CommandArgs<C>, queries: QueriesOf<A>) => ReadonlyArray<Query.Patch>)
    | undefined;
  /** Entries a success stores without a refetch. */
  readonly writes?:
    | ((
        success: Success<C>,
        args: CommandArgs<C>,
        queries: QueriesOf<A>,
      ) => ReadonlyArray<Query.Write>)
    | undefined;
}

/** Options for one query. `key` and `take` apply to a paged query only. */
export interface QueryConfig<Q extends DomainQuery.Any> {
  /** Identifies an entry, so a repeat on a later page is left out. By default none is. */
  readonly key?: ((entry: Api.EntryOf<Q>) => string) | undefined;
  /** Entries per page, capped by the query Layer's `take.max`. */
  readonly take?: number | undefined;
}

/** Options for one View's stream query. */
export interface ViewConfig {
  /**
   * How long an unwatched entry keeps its stream open. Defaults to Effect UI's 5 minutes: one
   * subscription per key stays open that long after its last component leaves.
   */
  readonly idleTimeToLive?: Duration.Input | undefined;
}

/** Options for `make`. */
export interface MakeOptions<A extends Api.Any = Api.Any> {
  /** How long a query result stays fresh. Defaults to 0: a cached result shows at once and refetches. */
  readonly staleTime?: Duration.Input | undefined;
  /** Per-command consistency and cache effects, by command tag. */
  readonly commands?:
    | { readonly [C in Api.CommandsOf<A> as C["tag"]]?: CommandConfig<A, C> }
    | undefined;
  /** Per-query paging options, by query name. */
  readonly queries?:
    | { readonly [Q in Api.QueriesOf<A> as Q["queryName"]]?: QueryConfig<Q> }
    | undefined;
  /** Per-View stream query options, by View name. */
  readonly views?: { readonly [V in Views<A> as V["viewName"]]?: ViewConfig } | undefined;
}

type StrongOf<O, Tag extends string> = O extends { readonly commands?: infer Cs }
  ? Tag extends keyof NonNullable<Cs>
    ? NonNullable<Cs>[Tag] extends { readonly consistency?: infer K }
      ? [K] extends ["strong"]
        ? true
        : false
      : false
    : false
  : false;

/**
 * Commands, queries, View stream queries and read Subscriptions computed from the Api's entries.
 * A View is a stream query with `watch`, `events` and its snapshot Schema beside it. `layer` is
 * reserved.
 */
export type ClientOf<A extends Api.Any, O = {}> = {
  readonly [C in Api.CommandsOf<A> as C["tag"]]: CommandOf<A, C, StrongOf<O, C["tag"]>>;
} & QueriesOf<A> & {
    readonly [V in Reads<A> as ReadName<V>]: ReadClientOf<A, V> &
      (V extends View.Any ? SnapshotOf<V> : {});
  } & {
    /** The implementation of every Command and query, from the Api client. */
    readonly layer: Layer.Layer<Services<A>, never, LayerRequirements<A>>;
  };

const Receipt = Schema.Struct({ stream: Schema.String, version: Schema.Number });

/** At most this many streams are held for read-your-writes. */
const heldLimit = 32;

/**
 * The receipts of this client's commands, newest last, one per stream. A query with `waitsFor`
 * passes them as `atLeast`, so it sees this client's writes. Remove once the Domain client
 * remembers its own receipts (alchemy-run/alchemy#3800).
 */
class Held extends Context.Service<Held, Ref.Ref<ReadonlyArray<Receipt>>>()(
  "@alchemy.run/domain/EffectUI/Held",
) {}

const hold = (held: Ref.Ref<ReadonlyArray<Receipt>>, receipts: ReadonlyArray<Receipt>) =>
  Ref.update(held, (current) => {
    let next = current;
    for (const receipt of receipts) {
      const prior = next.find((r) => r.stream === receipt.stream);
      if (prior !== undefined && prior.version >= receipt.version) continue;
      next = [...next.filter((r) => r.stream !== receipt.stream), receipt];
    }
    return next.length > heldLimit ? next.slice(next.length - heldLimit) : next;
  });

type AnyClient = Record<string, unknown>;
type QueryCall = (
  input: unknown,
  options: DomainQuery.RunOptions & { readonly headers?: Headers.Input | undefined },
) => Effect.Effect<unknown, unknown>;

/** Look the headers up on each call: under `layer`, else where the Command runs. */
const headersFor = (name: string) =>
  Effect.serviceOption(CommandHeaders).pipe(
    Effect.flatMap((headers) =>
      Option.isSome(headers) ? headers.value.get(name) : Effect.succeed(undefined),
    ),
  );

const inputOf = (rpc: Rpc.Any) =>
  Schema.toType(
    ((rpc as Rpc.AnyWithProps).payloadSchema as Schema.Struct<{ input: Schema.Top }>).fields.input,
  );

/** The event tags a read handles from `source`: by tag, or by the source's name. */
const handles = (handlers: object | undefined, tag: string, source: string) =>
  handlers !== undefined && (tag in handlers || source in handlers);

/**
 * Whether a command's events can change what a read holds: a view or projection that handles
 * one, directly or through the views it reads. A stream's writers are not known here: yes.
 */
const reachedBy = (read: DomainQuery.Waitable | View.Any, tags: ReadonlySet<string>): boolean => {
  if (read.kind === "Stream") return true;
  const def = read.definition;
  const consumes = (tag: string, source: string) =>
    read.kind === "View"
      ? handles(read.definition.evolve, tag, source) ||
        handles(read.definition.emit, tag, source) ||
        handles(read.definition.keyOf, tag, source)
      : (read as Projection.Any).definition.on.some((event) => event.tag === tag);
  return def.from.some((source) => {
    const name = nameOf(source);
    if (source.kind === "View") {
      return (
        reachedBy(source as View.Any, tags) &&
        outputEvents(source as View.Any).some((event) => consumes(event.tag, name))
      );
    }
    return (source as Aggregate.Any).definition.events.some(
      (event) => tags.has(event.tag) && consumes(event.tag, name),
    );
  });
};

/** The default invalidation: every query whose `waitsFor` the command's events reach. */
const defaultTargets = (
  command: DomainCommand.Any,
  queries: ReadonlyArray<readonly [DomainQuery.Any, Query.Target]>,
): ReadonlyArray<Query.Target> => {
  const tags = new Set(command.events.map((event) => event.tag));
  return queries
    .filter(([query]) =>
      (query.definition.waitsFor ?? []).some((read) => tags.size === 0 || reachedBy(read, tags)),
    )
    .map(([, target]) => target);
};

const commandService = (
  api: Api.Any,
  command: DomainCommand.Any,
  config: CommandConfig<Api.Any, DomainCommand.Any>,
  queries: () => QueriesOf<Api.Any>,
  defaults: () => ReadonlyArray<Query.Target>,
) => {
  const strong = config.consistency === "strong";
  const rejection = Schema.Union(command.rejects);
  const denial = Schema.Union(command.middleware.map((middleware) => middleware.error));
  const { invalidates, optimistic, writes } = config;
  const service = Command.Service<any>()(`${api.apiName}/${command.tag}`, {
    args: {
      input: inputOf(command.rpc),
      commandId: Schema.optional(Schema.String),
      headers: Schema.optional(Schema.Record(Schema.String, Schema.String).pipe(Schema.Redacted)),
    },
    success: Schema.Struct({
      commandId: Schema.String,
      reply: (command.reply ?? Schema.Void) as Schema.Top,
      receipt: Receipt,
      commits: Schema.Array(Receipt),
    }),
    error: Schema.Union([
      Schema.TaggedStruct("Rejected", { commandId: Schema.String, rejection }),
      Schema.TaggedStruct("Denied", { commandId: Schema.String, error: denial }),
      Schema.TaggedStruct("Unknown", { commandId: Schema.String }),
      ...(strong
        ? [Schema.TaggedStruct("TimedOut", { commandId: Schema.String, receipt: Receipt })]
        : []),
    ]),
    invalidates: (args: any) =>
      invalidates === undefined ? defaults() : invalidates(args, queries()),
    ...(optimistic === undefined ? {} : { optimistic: (args: any) => optimistic(args, queries()) }),
    ...(writes === undefined
      ? {}
      : { writes: (success: any, args: any) => writes(success, args, queries()) }),
  } as any);
  const layer = service.toLayer(
    Effect.gen(function* () {
      const client = (yield* Effect.service(api.Client)) as AnyClient;
      const held = yield* Held;
      // The context, not the headers, is captured once per Layer build: the services the command
      // client needs (its middleware), and `CommandHeaders` when it is provided under `layer`.
      const context = yield* Effect.context<never>();
      return (args: CommandArgs<DomainCommand.Any>) =>
        Effect.gen(function* () {
          const commandId = args.commandId ?? (yield* yield* NewCommandId);
          return yield* Effect.gen(function* () {
            const callHeaders = Headers.fromInput(yield* headersFor(command.tag));
            const headers =
              args.headers === undefined
                ? callHeaders
                : Headers.setAll(callHeaders, Redacted.value(args.headers));
            const { reply, ...receipt } = (yield* sendPayload(
              client[command.tag],
              {
                input: args.input,
                commandId,
                ...(config.consistency === undefined ? {} : { consistency: config.consistency }),
              },
              { headers },
            )) as { reply: unknown; stream: string; version: number; commits: Array<Receipt> };
            yield* hold(held, receipt.commits);
            return {
              commandId,
              reply,
              receipt: { stream: receipt.stream, version: receipt.version },
              commits: receipt.commits,
            };
          }).pipe(
            Effect.catchCauseIf(
              (cause) => Cause.hasFails(cause) || Cause.hasDies(cause),
              (cause) => {
                if (Cause.hasDies(cause)) return Effect.fail({ _tag: "Unknown", commandId });
                const error = cause.pipe(Cause.findErrorOption, Option.getOrUndefined);
                if (Schema.is(View.ConsistencyTimeout)(error)) {
                  // Committed: the next read waits for it, whatever the caller does.
                  const receipt = { stream: error.stream, version: error.version };
                  return hold(held, [receipt]).pipe(
                    Effect.andThen(
                      Effect.fail(
                        strong
                          ? { _tag: "TimedOut", commandId, receipt }
                          : { _tag: "Unknown", commandId },
                      ),
                    ),
                  );
                }
                return Effect.fail(classifyFailure(command, commandId, error));
              },
            ),
          );
        }).pipe(Effect.provide(context)) as Effect.Effect<any, any>;
    }) as Effect.Effect<any, never, any>,
  );
  return { service, layer };
};

type Guards = Readonly<{
  rejects: ReadonlyArray<Schema.Top>;
  middleware: ReadonlyArray<{ readonly error: Schema.Top }>;
}>;

const queryGuards = (query: DomainQuery.Any): Guards => ({
  rejects: query.definition.rejects ?? [],
  middleware: query.middleware,
});

const viewGuards = (view: View.Any): Guards => ({
  rejects: view.definition.rejects ?? [],
  middleware: (view.definition.middleware ?? []) as Guards["middleware"],
});

/** The failure Schema of a read: its rejections, its middleware's errors, a timeout, the rest. */
const readError = ({ rejects, middleware }: Guards) =>
  Schema.Union([
    Schema.TaggedStruct("Rejected", { rejection: Schema.Union(rejects) }),
    Schema.TaggedStruct("Denied", {
      error: Schema.Union(middleware.map((m) => m.error)),
    }),
    Schema.TaggedStruct("TimedOut", {}),
    Schema.TaggedStruct("Unknown", {}),
  ]) as any;

/** A read's failure as a Schema value; a defect is `Unknown`, interruption stays. */
const readFailure = (guards: Guards, cause: Cause.Cause<unknown>) =>
  Cause.hasDies(cause)
    ? { _tag: "Unknown" }
    : classifyRead(guards, cause.pipe(Cause.findErrorOption, Option.getOrUndefined));

/** Run one query call with the per-call headers and this client's receipts, typed failures kept. */
const fetchQuery = (
  query: DomainQuery.Any,
  call: QueryCall,
  held: Ref.Ref<ReadonlyArray<Receipt>>,
  input: unknown,
  page: { readonly after?: string; readonly take?: number },
) => {
  const waits = (query.definition.waitsFor ?? []).length > 0;
  return Effect.gen(function* () {
    const headers = yield* headersFor(query.queryName);
    const atLeast = waits ? yield* Ref.get(held) : [];
    return yield* call(input, {
      headers,
      ...(atLeast.length === 0 ? {} : { atLeast }),
      ...page,
    } as DomainQuery.RunOptions);
  }).pipe(
    Effect.catchCauseIf(
      (cause) => Cause.hasFails(cause) || Cause.hasDies(cause),
      (cause) => Effect.fail(readFailure(queryGuards(query), cause)),
    ),
  );
};

const queryService = (
  api: Api.Any,
  query: DomainQuery.Any,
  options: MakeOptions,
  config: QueryConfig<DomainQuery.Any>,
) => {
  const name = query.queryName;
  const { successSchema } = query.rpc as Rpc.AnyWithProps;
  const guards = queryGuards(query);
  const shared = {
    args: { input: inputOf(query.rpc) },
    error: readError(guards),
    staleTime: options.staleTime ?? 0,
  };
  // The cast skips Effect UI's NoServices check: a success Schema that needs services to decode
  // fails only at runtime.
  const service = query.definition.paged
    ? (() => {
        // Without a `key`, every entry is kept: a fresh key per entry.
        let unkeyed = 0;
        return Query.InfiniteService<any>()(`${api.apiName}/${name}`, {
          ...shared,
          page: successSchema as any,
          items: (page: DomainQuery.Page<unknown>) => page.entries,
          key: config.key ?? (() => `~${unkeyed++}`),
          cursor: Schema.String,
          next: (page: DomainQuery.Page<unknown>) => Option.fromNullishOr(page.cursor),
        } as any);
      })()
    : Query.Service<any>()(`${api.apiName}/${name}`, {
        ...shared,
        success: successSchema as Schema.Top as any,
      });
  const build = Effect.gen(function* () {
    const client = (yield* Effect.service(api.Client)) as Record<string, QueryCall>;
    const held = yield* Held;
    // The context, not the headers, is captured once per Layer build: `CommandHeaders` when it
    // is provided under `layer`.
    const context = yield* Effect.context<never>();
    return query.definition.paged
      ? ({ input }: QueryArgs<DomainQuery.Any>, cursor: Option.Option<string>) =>
          fetchQuery(query, client[name]!, held, input, {
            ...(Option.isSome(cursor) ? { after: cursor.value } : {}),
            ...(config.take === undefined ? {} : { take: config.take }),
          }).pipe(Effect.provide(context))
      : ({ input }: QueryArgs<DomainQuery.Any>) =>
          fetchQuery(query, client[name]!, held, input, {}).pipe(Effect.provide(context));
  }) as Effect.Effect<any, never, any>;
  return { service, layer: (service as any).toLayer(build) as Layer.Layer<any, never, any> };
};

const classifyRead = ({ rejects, middleware }: Guards, error: unknown) => {
  if (rejects.some((rejection) => Schema.is(rejection)(error))) {
    return { _tag: "Rejected", rejection: error };
  }
  if (middleware.some((m) => Schema.is(m.error)(error))) {
    return { _tag: "Denied", error };
  }
  if (Schema.is(View.ConsistencyTimeout)(error)) return { _tag: "TimedOut" };
  return { _tag: "Unknown" };
};

const classifyFailure = (command: DomainCommand.Any, commandId: string, error: unknown) => {
  if (command.rejects.some((rejection) => Schema.is(rejection)(error))) {
    return { _tag: "Rejected", commandId, rejection: error };
  }
  if (command.middleware.some((middleware) => Schema.is(middleware.error)(error))) {
    return { _tag: "Denied", commandId, error };
  }
  return { _tag: "Unknown", commandId };
};

/** Turn a read failure into a Message, a defect into `onDefect`, and keep interruption. */
const settle =
  <Message>(
    onFailure: (error: any) => Message,
    onDefect: (cause: Cause.Cause<unknown>) => Message,
  ) =>
  (cause: Cause.Cause<unknown>): Stream.Stream<Message> => {
    if (Cause.hasDies(cause)) {
      return Stream.succeed(onDefect(cause));
    }
    const error = Cause.findErrorOption(cause);
    // Only interruption is left: keep it.
    return Option.isSome(error)
      ? Stream.succeed(onFailure(error.value))
      : Stream.failCause(cause as Cause.Cause<never>);
  };

/** Decode snapshot wire data, converting null state to Option.none. */
const snapshotSchema = <State extends Schema.Top>(state: State) =>
  Schema.Struct({
    state: Schema.OptionFromNullOr(state),
    cursor: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  });

/**
 * A View as a stream query entry. The first element is `snapshot` with this client's receipts as
 * `atLeast`, so it holds the client's own writes: after an optimistic run, the reopened stream's
 * first element is the confirmed state, not one from before the write. Then `watch` follows, not
 * `events`: a View that declares `events` can change state without emitting one.
 */
const viewQuery = (api: Api.Any, view: View.Any, name: string, config: ViewConfig) => {
  const rpc = readRpcs(view).snapshot as Rpc.AnyWithProps;
  const key = Schema.toType((rpc.payloadSchema as Schema.Struct<{ key: Schema.Top }>).fields.key);
  const guards = viewGuards(view);
  const service = Query.StreamService<any>()(`${api.apiName}/${name}`, {
    args: { key },
    success: snapshotSchema(
      (view.definition.state ?? Schema.Never) as Schema.Schema<unknown> & {
        readonly DecodingServices: never;
      },
    ),
    error: readError(guards),
    ...(config.idleTimeToLive === undefined ? {} : { idleTimeToLive: config.idleTimeToLive }),
  } as any);
  const build = Effect.gen(function* () {
    const client = (yield* Effect.service(api.Client)) as Record<string, Api.ViewClient<View.Any>>;
    const held = yield* Held;
    // The context, not the headers, is captured once per Layer build, as for queries.
    const context = yield* Effect.context<never>();
    return ({ key }: { readonly key: string }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const reader = client[name]!;
          const headers = yield* headersFor(name);
          const atLeast = yield* Ref.get(held);
          const first = yield* reader.snapshot(key as never, {
            headers,
            ...(atLeast.length === 0 ? {} : { atLeast }),
          });
          let cursor = first.cursor;
          return Stream.succeed(first).pipe(
            Stream.concat(
              // Suspended: a server render takes the first element and never opens the watch.
              Stream.suspend(() => reader.watch(key as never, { headers })).pipe(
                // `watch` opens after the snapshot, so it starts at or past it. A state at an
                // older cursor is stale; one at the same cursor can still be new.
                Stream.filter((snapshot) => {
                  if (snapshot.cursor < cursor) return false;
                  cursor = snapshot.cursor;
                  return true;
                }),
              ),
            ),
          );
        }),
      ).pipe(
        Stream.map(({ state, cursor }) => ({ state: Option.fromNullishOr(state), cursor })),
        Stream.catchCause((cause) =>
          Cause.hasFails(cause) || Cause.hasDies(cause)
            ? Stream.fail(readFailure(guards, cause))
            : Stream.failCause(cause),
        ),
        Stream.provideContext(context),
      );
  }) as Effect.Effect<any, never, any>;
  return { service, layer: (service as any).toLayer(build) as Layer.Layer<any, never, any> };
};

/** `watch` copies the View's state into the Model; the stream query keeps it out. */
const readClient = (api: Api.Any, entry: ReadEntry, name: string) => ({
  watch: (key: string, options: WatchOptions<unknown, ReadEntry>) =>
    Subscription.make(`${api.apiName}/${name}/watch`, [key, options.restartKey ?? null], () =>
      Stream.unwrap(
        api.Client.pipe(
          Effect.map((client) =>
            (client as Record<string, ReadClient<ReadEntry>>)[name].watch(key),
          ),
        ),
      ).pipe(
        Stream.map(({ state, cursor }) =>
          options.onSnapshot({ state: Option.fromNullishOr(state), cursor }, key),
        ),
        Stream.catchCause(settle(options.onFailure, options.onDefect)),
      ),
    ),
  events: (key: string, options: EventsOptions<unknown, ReadEntry>) =>
    Subscription.make(`${api.apiName}/${name}/events`, [key, options.restartKey ?? null], () =>
      Stream.suspend(() => {
        let delivered = Option.getOrElse(options.after, () => 0);
        return Stream.unwrap(
          api.Client.pipe(
            Effect.map((client) =>
              (client as Record<string, ReadClient<ReadEntry>>)[name].events(key, {
                after: Option.getOrUndefined(options.after),
              }),
            ),
          ),
        ).pipe(
          // A filtered feed has gaps; a replay after a reconnect repeats entries.
          Stream.filter((frame) => {
            if (Read.isCaughtUp(frame)) {
              return true;
            }
            if (frame.envelope.seq <= delivered) {
              return false;
            }
            delivered = frame.envelope.seq;
            return true;
          }),
          Stream.map((frame) =>
            Read.isCaughtUp(frame) ? options.onCaughtUp(frame.cursor, key) : options.onEntry(frame),
          ),
          Stream.catchCause(settle(options.onFailure, options.onDefect)),
        );
      }),
    ),
  ...(entry.kind === "View"
    ? (() => {
        const schema = snapshotSchema(
          (entry.definition.state ?? Schema.Never) as Schema.Schema<unknown> & {
            readonly DecodingServices: never;
          },
        );
        return { SnapshotSchema: schema, decodeSnapshot: Schema.decodeUnknownOption(schema) };
      })()
    : {}),
});

/**
 * Build Effect UI Commands, queries and Subscriptions for an Api. Provide `layer`, and the Api
 * client it needs, where the app mounts.
 *
 * By default a command invalidates every query whose `waitsFor` reads its events reach, and no
 * other query: a query without `waitsFor` refetches only when a command's `invalidates` names it.
 * A View's stream query is never invalidated by default: its open stream pushes the change. Its
 * optimistic patch reopens it once the run succeeds (see `viewQuery`).
 */
export function make<A extends Api.Any>(
  api: A & ("layer" extends keyof Api.ClientOf<A> ? never : unknown),
): ClientOf<A>;
// A separate overload, not a defaulted `O`: a default stops TypeScript typing the callbacks.
export function make<A extends Api.Any, const O extends MakeOptions<A>>(
  api: A & ("layer" extends keyof Api.ClientOf<A> ? never : unknown),
  options: O,
): ClientOf<A, O>;
export function make(api: Api.Any, options: MakeOptions = {}): unknown {
  const client: Record<string, unknown> = {};
  const layers: Array<Layer.Layer<any, never, any>> = [];
  const targets: Array<readonly [DomainQuery.Any, Query.Target]> = [];
  const queryConfigs = (options.queries ?? {}) as Record<string, QueryConfig<DomainQuery.Any>>;
  const viewConfigs = (options.views ?? {}) as Record<string, ViewConfig>;
  for (const entry of api.serves) {
    if (entry.kind === "Query") {
      const query = entry as DomainQuery.Any;
      const { service, layer } = queryService(
        api,
        query,
        options,
        queryConfigs[query.queryName] ?? {},
      );
      client[query.queryName] = service;
      targets.push([query, service as Query.Target]);
      layers.push(layer);
    } else if (entry.kind === "View") {
      const name = nameOf(entry);
      const { service, layer } = viewQuery(api, entry, name, viewConfigs[name] ?? {});
      client[name] = Object.assign(service, readClient(api, entry, name));
      layers.push(layer);
    } else if (entry.kind === "Stream") {
      const name = nameOf(entry);
      client[name] = readClient(api, entry, name);
    }
  }
  const commandConfigs = (options.commands ?? {}) as Record<
    string,
    CommandConfig<Api.Any, DomainCommand.Any>
  >;
  for (const command of api.commands) {
    let defaults: ReadonlyArray<Query.Target> | undefined;
    const { service, layer } = commandService(
      api,
      command,
      commandConfigs[command.tag] ?? {},
      () => client as QueriesOf<Api.Any>,
      () => (defaults ??= defaultTargets(command, targets)),
    );
    client[command.tag] = service;
    layers.push(layer);
  }
  client.layer =
    layers.length === 0
      ? Layer.empty
      : Layer.mergeAll(...(layers as [any, ...any[]])).pipe(
          Layer.provide(Layer.effect(Held, Ref.make<ReadonlyArray<Receipt>>([]))),
        );
  return client;
}
