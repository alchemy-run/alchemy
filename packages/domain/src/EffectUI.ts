import { Command, Query, Subscription } from "@effect/ui";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Aggregate from "./Aggregate.ts";
import type * as Api from "./Api.ts";
import type * as DomainCommand from "./Command.ts";
import { sendPayload } from "./internal.ts";
import type * as Middleware from "./Middleware.ts";
import type * as DomainQuery from "./Query.ts";
import * as Read from "./Read.ts";
import { nameOf } from "./ReadRpcs.ts";
import type * as DomainStream from "./Stream.ts";
import * as View from "./View.ts";

/**
 * Per-call headers, read when a Command or query runs, never part of its args. Provide it under
 * `layer` (`Bank.layer.pipe(Layer.provide(Headers))`): a query can fetch outside the component that
 * asked for it, so a sibling of `layer` reaches Commands but not every query fetch.
 */
export class CommandHeaders extends Context.Service<
  CommandHeaders,
  {
    readonly get: (name: string) => Effect.Effect<Headers.Input>;
  }
>()("@alchemy.run/domain/EffectUI/CommandHeaders") {}

/** Page-local command id state. Give each page load a fresh session. */
export const CommandIds = Schema.Struct({ session: Schema.String, sent: Schema.Number });
/** Page-local command id state. */
export type CommandIds = typeof CommandIds.Type;

/** Allocate an id without reading time or changing the supplied state. */
export const next = (ids: CommandIds) => ({
  commandId: `${ids.session}:${ids.sent}`,
  commandIds: CommandIds.make({ session: ids.session, sent: ids.sent + 1 }),
});

type Input<C extends DomainCommand.Any> = Omit<C["Type"], "_tag">;
type Reply<C extends DomainCommand.Any> = C["reply"] extends Schema.Top ? C["reply"]["Type"] : void;
type Rejection<C extends DomainCommand.Any> = C["rejects"][number]["Type"];
type Denial<C extends DomainCommand.Any> = C["middleware"][number]["error"]["Type"];

/** One stream a command committed to. */
export type Receipt = Readonly<{ stream: string; version: number }>;

/** A committed command: its reply, the first stream it wrote (a read's `atLeast`), and every stream. */
export type Success<C extends DomainCommand.Any> = Readonly<{
  commandId: string;
  reply: Reply<C>;
  receipt: Receipt;
  commits: ReadonlyArray<Receipt>;
}>;

/** A refusal is final; an unknown outcome can be retried with the same id. */
export type Failure<C extends DomainCommand.Any> =
  | Readonly<{ _tag: "Rejected"; commandId: string; rejection: Rejection<C> }>
  | Readonly<{ _tag: "Denied"; commandId: string; error: Denial<C> }>
  | Readonly<{ _tag: "Unknown"; commandId: string }>;

type QueryRejection<Q extends DomainQuery.Any> = Aggregate.InstanceOf<
  NonNullable<Q["definition"]["rejects"]>[number]
>;

type QueryRefusal<Q extends DomainQuery.Any> =
  | Readonly<{ _tag: "Rejected"; rejection: QueryRejection<Q> }>
  | Readonly<{ _tag: "Denied"; error: Middleware.Errors<Q["middleware"]> }>
  | Readonly<{ _tag: "Unknown" }>;

/**
 * A query refusal (`Rejected`, `Denied`) is final. `TimedOut` (only for a query with
 * `waitsFor`) means its projections did not reach `atLeast` in time; `Unknown` is transport or a defect.
 * Both can be asked again.
 */
export type QueryFailure<Q extends DomainQuery.Any> =
  NonNullable<Q["definition"]["waitsFor"]> extends readonly []
    ? QueryRefusal<Q>
    : QueryRefusal<Q> | Readonly<{ _tag: "TimedOut" }>;

/** The args of one Api command's Command: the input and a caller-owned id that survives retries. */
export type CommandArgs<C extends DomainCommand.Any> = Readonly<{
  input: Input<C>;
  commandId: string;
}>;

/** The args of one Api query: its input, and the read options a Domain query takes. */
export type QueryArgs<Q extends DomainQuery.Any> = Readonly<{
  input: DomainQuery.InputOf<Q>;
  atLeast?: Receipt | ReadonlyArray<Receipt> | undefined;
  after?: string | undefined;
  take?: number | undefined;
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
export type CommandOf<A extends Api.Any, C extends DomainCommand.Any> = Command.Service<
  CommandService<A["apiName"], C["tag"]>,
  string,
  CommandArgs<C>,
  Schema.Schema<Success<C>>,
  false,
  Schema.Schema<Failure<C>>
>;

/** An Effect UI Query service for one Api query. */
export type QueryOf<A extends Api.Any, Q extends DomainQuery.Any> = Query.Service<
  QueryService<A["apiName"], Q["queryName"]>,
  string,
  QueryArgs<Q>,
  DomainQuery.ResultOf<Q>,
  QueryFailure<Q>
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

/** A watch snapshot with explicit absence for Effect UI Models. */
export type Snapshot<State> = Readonly<{
  state: Option.Option<NonNullable<State>>;
  cursor: number;
}>;

/** Callbacks for live read state. */
export interface WatchOptions<Message, V extends ReadEntry> {
  /** The snapshot, and the key it is of: a Model that keeps several keys files it under this one. */
  readonly onSnapshot: (snapshot: Snapshot<StateOf<V>>, key: ReadKey<V>) => Message;
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

/** Subscriptions for one View or Stream. Return them from a component's `subscriptions`. */
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

type Services<A extends Api.Any> =
  | {
      [C in Api.CommandsOf<A> as C["tag"]]: CommandService<A["apiName"], C["tag"]>;
    }[Api.CommandsOf<A>["tag"]]
  | {
      [Q in Api.QueriesOf<A> as Q["queryName"]]: QueryService<A["apiName"], Q["queryName"]>;
    }[Api.QueriesOf<A>["queryName"]];

type LayerRequirements<A extends Api.Any> =
  | A["Client"]["Identifier"]
  | {
      [C in Api.CommandsOf<A> as C["tag"]]: Effect.Services<ReturnType<Api.CommandClient<C>>>;
    }[Api.CommandsOf<A>["tag"]];

/** Commands, queries and read Subscriptions computed from the Api's entries. `layer` is reserved. */
export type ClientOf<A extends Api.Any> = {
  readonly [C in Api.CommandsOf<A> as C["tag"]]: CommandOf<A, C>;
} & {
  readonly [Q in Api.QueriesOf<A> as Q["queryName"]]: QueryOf<A, Q>;
} & {
  readonly [V in Reads<A> as ReadName<V>]: ReadClientOf<A, V>;
} & {
  /** The implementation of every Command and query, from the Api client. */
  readonly layer: Layer.Layer<Services<A>, never, LayerRequirements<A>>;
};

/** Options for `make`. */
export interface MakeOptions {
  /** How long a query result stays fresh. Defaults to 0: a cached result shows at once and refetches. */
  readonly staleTime?: Duration.Input | undefined;
}

const Receipt = Schema.Struct({ stream: Schema.String, version: Schema.Number });
/** A query's `atLeast`: one receipt, or one per command. */
const Receipts = Schema.Union([Receipt, Schema.Array(Receipt)]);

type AnyClient = Record<string, unknown>;

/** Look the headers up on each call: under `layer`, else where the Command runs. */
const headersFor = (name: string) =>
  Effect.serviceOption(CommandHeaders).pipe(
    Effect.flatMap((headers) =>
      Option.isSome(headers) ? headers.value.get(name) : Effect.succeed(undefined),
    ),
  );

const commandService = (api: Api.Any, command: DomainCommand.Any) => {
  const { payloadSchema } = command.rpc as Rpc.AnyWithProps;
  const rejection = Schema.Union(command.rejects);
  const denial = Schema.Union(command.middleware.map((middleware) => middleware.error));
  const service = Command.Service<any>()(`${api.apiName}/${command.tag}`, {
    args: {
      input: Schema.toType((payloadSchema as Schema.Struct<{ input: Schema.Top }>).fields.input),
      commandId: Schema.String,
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
    ]),
  });
  const layer = service.toLayer(
    Effect.gen(function* () {
      const client = (yield* Effect.service(api.Client)) as AnyClient;
      // The context, not the headers, is captured once per Layer build: the services the command
      // client needs (its middleware), and `CommandHeaders` when it is provided under `layer`.
      const context = yield* Effect.context<never>();
      return (args: { readonly input: unknown; readonly commandId: string }) =>
        Effect.gen(function* () {
          const { commandId } = args;
          const callHeaders = yield* headersFor(command.tag);
          const { reply, ...receipt } = (yield* sendPayload(client[command.tag], args, {
            headers: callHeaders,
          })) as { reply: unknown; stream?: string; version?: number; commits?: unknown };
          return {
            commandId,
            reply,
            receipt: { stream: receipt.stream, version: receipt.version },
            commits: receipt.commits,
          };
        }).pipe(
          Effect.catchCauseIf(
            (cause) => Cause.hasFails(cause) || Cause.hasDies(cause),
            (cause) =>
              Effect.fail(
                Cause.hasDies(cause)
                  ? { _tag: "Unknown", commandId: args.commandId }
                  : classifyFailure(
                      command,
                      args.commandId,
                      cause.pipe(Cause.findErrorOption, Option.getOrUndefined),
                    ),
              ),
          ),
          Effect.provide(context),
        ) as Effect.Effect<any, any>;
    }) as Effect.Effect<any, never, any>,
  );
  return { service, layer };
};

const queryService = (api: Api.Any, query: DomainQuery.Any, options: MakeOptions) => {
  const name = query.queryName;
  const { payloadSchema, successSchema } = query.rpc as Rpc.AnyWithProps;
  const service = Query.Service<any>()(`${api.apiName}/${name}`, {
    args: {
      input: Schema.toType((payloadSchema as Schema.Struct<{ input: Schema.Top }>).fields.input),
      atLeast: Schema.optional(Receipts),
      after: Schema.optional(Schema.String),
      take: Schema.optional(Schema.Number),
    },
    // The cast skips Effect UI's NoServices check: a success Schema that needs services to decode
    // fails only at runtime.
    success: successSchema as Schema.Top as any,
    error: Schema.Union([
      Schema.TaggedStruct("Rejected", { rejection: Schema.Union(query.definition.rejects ?? []) }),
      Schema.TaggedStruct("Denied", {
        error: Schema.Union(query.middleware.map((middleware) => middleware.error)),
      }),
      Schema.TaggedStruct("TimedOut", {}),
      Schema.TaggedStruct("Unknown", {}),
    ]) as any,
    staleTime: options.staleTime ?? 0,
  });
  const layer = service.toLayer(
    Effect.gen(function* () {
      const client = (yield* Effect.service(api.Client)) as Record<
        string,
        (
          input: unknown,
          options: DomainQuery.RunOptions & { readonly headers?: Headers.Input | undefined },
        ) => Effect.Effect<unknown, unknown>
      >;
      // The context, not the headers, is captured once per Layer build: `CommandHeaders` when it
      // is provided under `layer`.
      const context = yield* Effect.context<never>();
      return ({ input, atLeast, after, take }: QueryArgs<DomainQuery.Any>) =>
        Effect.gen(function* () {
          const callHeaders = yield* headersFor(name);
          return yield* client[name](input, {
            headers: callHeaders,
            ...(atLeast === undefined ? {} : { atLeast }),
            ...(after === undefined ? {} : { after }),
            ...(take === undefined ? {} : { take }),
          } as DomainQuery.RunOptions);
        }).pipe(
          Effect.catchCauseIf(
            (cause) => Cause.hasFails(cause) || Cause.hasDies(cause),
            (cause) =>
              Effect.fail(
                Cause.hasDies(cause)
                  ? { _tag: "Unknown" }
                  : classifyQueryFailure(
                      query,
                      cause.pipe(Cause.findErrorOption, Option.getOrUndefined),
                    ),
              ),
          ),
          Effect.provide(context),
        );
    }) as Effect.Effect<any, never, any>,
  );
  return { service, layer };
};

const classifyQueryFailure = (query: DomainQuery.Any, error: unknown) => {
  if ((query.definition.rejects ?? []).some((rejection) => Schema.is(rejection)(error))) {
    return { _tag: "Rejected", rejection: error };
  }
  if (query.middleware.some((middleware) => Schema.is(middleware.error)(error))) {
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

const readClient = (api: Api.Any, entry: ReadEntry, name: string) => ({
  watch: (key: string, options: WatchOptions<unknown, ReadEntry>) =>
    Subscription.make(`${api.apiName}/${name}/watch`, [key], () =>
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
});

/**
 * Build Effect UI Commands, queries and Subscriptions for an Api. Provide `layer`, and the Api
 * client it needs, where the app mounts.
 */
export function make<A extends Api.Any>(
  api: A & ("layer" extends keyof Api.ClientOf<A> ? never : unknown),
  options?: MakeOptions,
): ClientOf<A>;
export function make(api: Api.Any, options: MakeOptions = {}): unknown {
  const client: Record<string, unknown> = {};
  const layers: Array<Layer.Layer<any, never, any>> = [];
  for (const command of api.commands) {
    const { service, layer } = commandService(api, command);
    client[command.tag] = service;
    layers.push(layer);
  }
  for (const entry of api.serves) {
    if (entry.kind === "Query") {
      const { service, layer } = queryService(api, entry as DomainQuery.Any, options);
      client[(entry as DomainQuery.Any).queryName] = service;
      layers.push(layer);
    } else if (entry.kind === "View" || entry.kind === "Stream") {
      const name = nameOf(entry);
      client[name] = readClient(api, entry, name);
    }
  }
  client.layer = layers.length === 0 ? Layer.empty : Layer.mergeAll(...(layers as [any, ...any[]]));
  return client;
}
