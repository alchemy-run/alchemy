import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { HttpEffect } from "../Http.ts";
import type * as Aggregate from "./Aggregate.ts";
import type * as Command from "./Command.ts";
import * as Domain from "./Domain.ts";
import type * as Event from "./Event.ts";
import { type Filter, matches } from "./Filter.ts";
import { captureContext } from "./internal.ts";
import { decodeEnvelope } from "./Kernel.ts";
import * as Middleware from "./Middleware.ts";
import type * as Read from "./Read.ts";
import type * as View from "./View.ts";

/**
 * What an Api exposes: commands (writes), views (reads), and aggregates that
 * declare a `read` contract.
 */
export type Entry = Command.Any | View.Any | Aggregate.Any;

type Commands<E extends Entry> = Extract<E, Command.Any>;
type Views<E extends Entry> = Extract<E, View.Any>;
type Aggregates<E extends Entry> = Exclude<E, Command.Any | View.Any>;

// ---------------------------------------------------------------- client types

type ContractOf<D> = D extends Read.AnyContract ? D : never;
type RejectsOf<D> = NonNullable<ContractOf<D>["rejects"]>[number];
type MiddlewareOf<D> = NonNullable<ContractOf<D>["middleware"]>;

/** Everything a read can fail with: the declared rejections, the middleware's errors, transport. */
export type ReadError<D> =
  | Aggregate.Inst<RejectsOf<D>>
  | Middleware.Errors<MiddlewareOf<D>>
  | RpcClientError.RpcClientError;

interface CallOptions {
  readonly headers?: Headers.Input;
}

/** The typed client of a view exposed in an Api. */
export interface ViewClient<V extends View.Any> {
  /** The key's current state (`null` if it does not exist or the filter excludes it). */
  readonly get: (
    key: Aggregate.IdOf<View.KeyOf<V>>,
    options?: CallOptions & {
      /** Wait until the view has applied this write (a command's `stream` and `version`). */
      readonly atLeast?: { readonly stream: string; readonly version: number };
      readonly where?: Filter<View.StateOf<V>>;
    },
  ) => Effect.Effect<View.StateOf<V> | null, ReadError<V["definition"]>>;
  /** The key's state, then every change. Ends with a rejection when `validate` stops allowing it. */
  readonly watch: (
    key: Aggregate.IdOf<View.KeyOf<V>>,
    options?: CallOptions & { readonly where?: Filter<View.StateOf<V>> },
  ) => Stream.Stream<View.StateOf<V> | null, ReadError<V["definition"]>>;
  /** The events the key emitted, each with the state after it: history, then live. */
  readonly events: (
    key: Aggregate.IdOf<View.KeyOf<V>>,
    options?: CallOptions & {
      readonly after?: string;
      readonly where?: Filter<View.EventOf<V>>;
    },
  ) => Stream.Stream<
    View.Entry<View.StateOf<V>, View.EventOf<V>, Aggregate.IdOf<View.KeyOf<V>>>,
    ReadError<V["definition"]>
  >;
  /** A page of the key's emitted events. */
  readonly list: (
    key: Aggregate.IdOf<View.KeyOf<V>>,
    options?: CallOptions & {
      readonly where?: Filter<View.EventOf<V>>;
      readonly order?: "asc" | "desc";
      readonly take?: number;
      readonly after?: string;
    },
  ) => Effect.Effect<
    View.Page<View.Entry<View.StateOf<V>, View.EventOf<V>, Aggregate.IdOf<View.KeyOf<V>>>>,
    ReadError<V["definition"]>
  >;
}

/** A committed event of an aggregate, as a client receives it. */
export interface Recorded<E, Id> {
  readonly event: E;
  readonly envelope: Aggregate.Envelope<Id>;
}

/** The typed client of an aggregate exposed in an Api (through its `read` contract). */
export interface AggregateClient<A extends Aggregate.Any> {
  /** The instance's current state. */
  readonly get: (
    key: Aggregate.IdOf<A>,
    options?: CallOptions,
  ) => Effect.Effect<Aggregate.StateOf<A>, ReadError<A["definition"]["read"]>>;
  /** The instance's state, then its state after every commit. */
  readonly watch: (
    key: Aggregate.IdOf<A>,
    options?: CallOptions,
  ) => Stream.Stream<Aggregate.StateOf<A>, ReadError<A["definition"]["read"]>>;
  /** The instance's committed events: history from `after` (a `seq`), then live. */
  readonly events: (
    key: Aggregate.IdOf<A>,
    options?: CallOptions & { readonly after?: number },
  ) => Stream.Stream<
    Recorded<Aggregate.EventOf<A>, Aggregate.IdOf<A>>,
    ReadError<A["definition"]["read"]>
  >;
}

/**
 * The typed client of an Api: commands as methods (`bank.WithdrawMoney(...)`),
 * views and aggregates as namespaces (`bank.AccountSummary.watch(...)`).
 */
export type ApiClient<E extends Entry> = RpcClient.RpcClient<Commands<E>["rpc"]> & {
  readonly [V in Views<E> as V["viewName"]]: ViewClient<V>;
} & {
  readonly [A in Aggregates<E> as A["aggregateName"]]: AggregateClient<A>;
};

/** Type-level identity of an Api's client service. */
export interface ClientKey<Name extends string> {
  readonly "~alchemy/Fold/Api/Client": Name;
}

/**
 * The class type returned by {@link make}.
 */
export interface ApiClass<Name extends string, Entries extends ReadonlyArray<Entry>> {
  new (_: never): {};
  readonly kind: "Api";
  readonly apiName: Name;
  /** The commands, views and aggregates this Api exposes. */
  readonly entries: Entries;
  /** The underlying Effect RPC group. */
  readonly group: RpcGroup.RpcGroup<Rpc.Any>;
  /**
   * Apply an `RpcMiddleware` to every entry (logging, rate limits). Middleware
   * that provides services, such as a session, is declared by each command,
   * view or aggregate instead, so what they may read stays typed.
   */
  middleware<M extends RpcMiddleware.AnyService>(
    middleware: [RpcMiddleware.Provides<M["Identifier"]>] extends [never]
      ? M
      : "Middleware that provides services is declared on each command, view or aggregate",
  ): ApiClass<Name, Entries>;
  /**
   * Serve the Api over HTTP (Effect RPC, NDJSON), returning an `HttpEffect`
   * to use as a Worker's `fetch`. Requires the Domain and the Layers of every
   * middleware the entries declare.
   */
  readonly httpEffect: Effect.Effect<
    HttpEffect,
    never,
    Domain.Internals | MiddlewareServices<Entries>
  >;
  /** A typed client. Provide a protocol with {@link protocolHttp}. */
  readonly client: Effect.Effect<
    ApiClient<Entries[number]>,
    never,
    Scope.Scope | RpcClient.Protocol | MiddlewareClients<Entries>
  >;
  /** The client as a service, for code that uses it without owning the connection. */
  readonly Client: Context.Service<ClientKey<Name>, ApiClient<Entries[number]>>;
  /** Build {@link Client} for the life of the Layer, over the protocol provided to it. */
  readonly layerClient: Layer.Layer<
    ClientKey<Name>,
    never,
    RpcClient.Protocol | MiddlewareClients<Entries>
  >;
  /**
   * An in-process client wired straight to the handlers, for tests. Server
   * middleware runs, so principals are provided by swapping middleware Layers.
   */
  readonly testClient: Effect.Effect<
    ApiClient<Entries[number]>,
    never,
    Scope.Scope | Domain.Internals | MiddlewareServices<Entries> | MiddlewareClients<Entries>
  >;
}

type EntryMiddleware<E> = E extends Command.Any
  ? E["middleware"][number]
  : E extends View.Any
    ? NonNullable<E["definition"]["middleware"]>[number]
    : E extends Aggregate.Any
      ? NonNullable<NonNullable<E["definition"]["read"]>["middleware"]>[number]
      : never;

/** The middleware services the server needs for every entry. */
type MiddlewareServices<Entries extends ReadonlyArray<Entry>> =
  EntryMiddleware<Entries[number]> extends infer M
    ? M extends RpcMiddleware.AnyService
      ? M["Identifier"]
      : never
    : never;

/** The client-side middleware every entry needs (e.g. attaching a session token). */
type MiddlewareClients<Entries extends ReadonlyArray<Entry>> =
  EntryMiddleware<Entries[number]> extends infer M
    ? M extends RpcMiddleware.AnyService
      ? M extends { readonly requiredForClient: true }
        ? RpcMiddleware.ForClient<M["Identifier"]>
        : never
      : never
    : never;

// ---------------------------------------------------------------- rpc schemas

const EnvelopeSchema = Schema.Struct({
  id: Schema.String,
  stream: Schema.String,
  seq: Schema.Number,
  at: Schema.DateTimeUtc,
  commandId: Schema.String,
});

const nameOf = (entry: View.Any | Aggregate.Any) =>
  entry.kind === "View" ? entry.viewName : entry.aggregateName;

const union = (members: ReadonlyArray<Schema.Top>) =>
  members.length === 0 ? Schema.Never : Schema.Union(members as ReadonlyArray<Schema.Top>);

/** The events a view emits: its declared events, or the events it applies. */
const outputEvents = (view: View.Any): ReadonlyArray<Event.Any> => {
  const def = view.definition;
  if (def.events) return def.events;
  const handles = (tag: string, source: string) =>
    Boolean(def.evolve?.[tag] || def.evolve?.[source] || def.emit?.[tag] || def.emit?.[source]);
  const out = new Set<Event.Any>();
  for (const source of def.from) {
    const name = nameOf(source);
    const events =
      source.kind === "View"
        ? outputEvents(source as View.Any)
        : (source as Aggregate.Any).definition.events;
    for (const event of events) if (handles(event.tag, name)) out.add(event);
  }
  return [...out];
};

interface ReadRpcs {
  readonly get: Rpc.Any;
  readonly watch: Rpc.Any;
  readonly events: Rpc.Any;
  readonly list?: Rpc.Any;
}

const contractOf = (entry: View.Any | Aggregate.Any): Read.AnyContract => {
  if (entry.kind === "View") return entry.definition;
  const read = entry.definition.read;
  if (!read) {
    throw new Error(`${entry.aggregateName} has no \`read\` contract, so an Api cannot expose it`);
  }
  return read;
};

const rpcCache = new WeakMap<object, ReadRpcs>();

/** The RPCs of a view or aggregate exposed in an Api. */
const readRpcs = (entry: View.Any | Aggregate.Any): ReadRpcs => {
  const cached = rpcCache.get(entry);
  if (cached) return cached;
  const name = nameOf(entry);
  const contract = contractOf(entry);
  const guard = (rpc: Rpc.Any) => Middleware.apply(rpc, contract.middleware ?? []);
  const error = union(contract.rejects ?? []);
  let rpcs: ReadRpcs;
  if (entry.kind === "View") {
    const def = entry.definition;
    const key = def.key.definition.id;
    const state = Schema.NullOr(def.state ?? Schema.Null);
    const recorded = Schema.Struct({
      event: union(outputEvents(entry)),
      state,
      envelope: EnvelopeSchema,
    });
    rpcs = {
      get: guard(
        Rpc.make(`${name}.get`, {
          payload: {
            key,
            atLeast: Schema.optional(
              Schema.Struct({ stream: Schema.String, version: Schema.Number }),
            ),
            where: Schema.optional(Schema.Unknown),
          },
          success: state,
          error,
        }),
      ),
      watch: guard(
        Rpc.make(`${name}.watch`, {
          payload: { key, where: Schema.optional(Schema.Unknown) },
          success: state,
          error,
          stream: true,
        }),
      ),
      events: guard(
        Rpc.make(`${name}.events`, {
          payload: {
            key,
            after: Schema.optional(Schema.String),
            where: Schema.optional(Schema.Unknown),
          },
          success: recorded,
          error,
          stream: true,
        }),
      ),
      list: guard(
        Rpc.make(`${name}.list`, {
          payload: {
            key,
            where: Schema.optional(Schema.Unknown),
            order: Schema.optional(Schema.Literals(["asc", "desc"])),
            take: Schema.optional(Schema.Number),
            after: Schema.optional(Schema.String),
          },
          success: Schema.Struct({
            entries: Schema.Array(recorded),
            cursor: Schema.NullOr(Schema.String),
          }),
          error,
        }),
      ),
    };
  } else {
    const def = entry.definition;
    const recorded = Schema.Struct({ event: union(def.events), envelope: EnvelopeSchema });
    rpcs = {
      get: guard(Rpc.make(`${name}.get`, { payload: { key: def.id }, success: def.state, error })),
      watch: guard(
        Rpc.make(`${name}.watch`, {
          payload: { key: def.id },
          success: def.state,
          error,
          stream: true,
        }),
      ),
      events: guard(
        Rpc.make(`${name}.events`, {
          payload: { key: def.id, after: Schema.optional(Schema.Number) },
          success: recorded,
          error,
          stream: true,
        }),
      ),
    };
  }
  rpcCache.set(entry, rpcs);
  return rpcs;
};

const rpcsOf = (entry: Entry): ReadonlyArray<Rpc.Any> =>
  entry.kind === "Command" ? [entry.rpc] : Object.values(readRpcs(entry));

// ---------------------------------------------------------------- handlers

/**
 * Only an entry's declared errors are public. Anything else (an
 * infrastructure error, an undeclared rejection) becomes a defect, so it
 * never leaks as a typed error the client cannot decode.
 */
const declaredOnly = (rpc: Rpc.Any) => {
  const props = rpc as Rpc.AnyWithProps;
  const isDeclared = Schema.is(props.errorSchema);
  const success = props.successSchema as Schema.Top & { readonly error?: Schema.Top };
  const isDeclaredInStream = success.error ? Schema.is(success.error) : isDeclared;
  return {
    effect: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.catchIf(
        effect,
        (e) => !isDeclared(e),
        (e) => Effect.die(e),
      ),
    stream: <A, E, R>(stream: Stream.Stream<A, E, R>) =>
      Stream.catchIf(
        stream,
        (e) => !isDeclaredInStream(e),
        (e) => Stream.die(e),
      ),
  };
};

/** The wire payload of a command: its target, an optional command id, and its input. */
interface CommandPayload {
  readonly target: string;
  readonly commandId?: string;
  readonly [field: string]: unknown;
}

interface ReadPayload {
  readonly key: string;
  readonly where?: unknown;
  readonly atLeast?: { readonly stream: string; readonly version: number };
  readonly after?: string | number;
  readonly order?: "asc" | "desc";
  readonly take?: number;
}

type Handler = (input: never) => unknown;

const handlersOf = (entries: ReadonlyArray<Entry>): Effect.Effect<Record<string, Handler>> =>
  Effect.gen(function* () {
    const internals = yield* Domain.Internals;
    const handlers: Record<string, Handler> = {};
    for (const entry of entries) {
      if (entry.kind === "Command") {
        const aggregate = internals.commands.get(entry.tag);
        if (!aggregate) {
          return yield* Effect.die(new Error(`No aggregate in the Domain handles ${entry.tag}`));
        }
        const declared = declaredOnly(entry.rpc);
        // Runs inside the command's middleware, so the context it provides
        // (the session's actor) travels with the command to its aggregate.
        handlers[entry.tag] = ({ target, commandId, ...input }: CommandPayload) =>
          declared.effect(
            aggregate.send(target, new entry(input), { commandId }).pipe(
              Effect.map((receipt) => ({
                reply: receipt.reply,
                stream: receipt.stream,
                version: receipt.version,
              })),
            ),
          );
        continue;
      }
      const name = nameOf(entry);
      const rpcs = readRpcs(entry);
      const validate = contractOf(entry).validate as
        | ((request: Read.Request<unknown>, state: unknown) => Effect.Effect<void, unknown>)
        | undefined;
      const check = (mode: Read.Mode, key: unknown) => (state: unknown) =>
        validate ? validate({ mode, key }, state) : Effect.void;
      const effect =
        (rpc: Rpc.Any, handle: (payload: ReadPayload) => Effect.Effect<unknown, unknown>) =>
        (payload: ReadPayload) =>
          declaredOnly(rpc).effect(handle(payload));
      const stream =
        (rpc: Rpc.Any, handle: (payload: ReadPayload) => Stream.Stream<unknown, unknown>) =>
        (payload: ReadPayload) =>
          declaredOnly(rpc).stream(handle(payload));

      if (entry.kind === "View") {
        const host = internals.viewHosts.get(name)!;
        const key = entry.definition.key;
        const refOf = (id: string) => ({ aggregate: key.aggregateName, id }) as Aggregate.Ref;
        const visible = (state: unknown, where: unknown) =>
          state !== null && matches(where as Filter<unknown> | undefined, state) ? state : null;
        handlers[`${name}.get`] = effect(rpcs.get, ({ key: id, atLeast, where }) =>
          host.query(refOf(id), { atLeast }).pipe(
            Effect.orDie,
            Effect.flatMap((found) => {
              const state = Option.getOrNull(found);
              return check("get", refOf(id))(state).pipe(Effect.as(visible(state, where)));
            }),
          ),
        );
        handlers[`${name}.watch`] = stream(rpcs.watch, ({ key: id, where }) =>
          host.watch(refOf(id)).pipe(
            Stream.mapEffect((found) => {
              const state = Option.getOrNull(found);
              return check("watch", refOf(id))(state).pipe(Effect.as(visible(state, where)));
            }),
          ),
        );
        handlers[`${name}.events`] = stream(rpcs.events, ({ key: id, after, where }) =>
          host
            .events(refOf(id), {
              after: after === undefined ? undefined : String(after),
              where: where as Filter<unknown> | undefined,
            })
            .pipe(
              Stream.mapEffect((entry) =>
                check("events", refOf(id))(entry.state).pipe(Effect.as(entry)),
              ),
            ),
        );
        handlers[`${name}.list`] = effect(rpcs.list!, ({ key: id, where, order, take, after }) =>
          host.query(refOf(id)).pipe(
            Effect.orDie,
            Effect.flatMap((found) => check("list", refOf(id))(Option.getOrNull(found))),
            Effect.andThen(
              host.list(refOf(id), {
                where: where as Filter<unknown> | undefined,
                order,
                take,
                after: after === undefined ? undefined : String(after),
              }),
            ),
          ),
        );
        continue;
      }

      const store = internals.aggregates.get(name)!;
      const refOf = (id: string) => ({ aggregate: name, id });
      const stateOf = (json: unknown) => internals.kernel.decodeState(entry, json);
      handlers[`${name}.get`] = effect(rpcs.get, ({ key: id }) =>
        store.state(id).pipe(
          Effect.flatMap(({ state }) => {
            const decoded = stateOf(state);
            return check("get", refOf(id))(decoded).pipe(Effect.as(decoded));
          }),
        ),
      );
      handlers[`${name}.watch`] = stream(rpcs.watch, ({ key: id }) =>
        store.changes(id).pipe(
          Stream.mapEffect(({ state }) => {
            const decoded = stateOf(state);
            return check("watch", refOf(id))(decoded).pipe(Effect.as(decoded));
          }),
        ),
      );
      handlers[`${name}.events`] = stream(rpcs.events, ({ key: id, after }) =>
        store.tail(id, typeof after === "number" ? after : 0).pipe(
          // Judged against the instance's state now, since events carry no state.
          Stream.mapEffect((stored) =>
            store.state(id).pipe(
              Effect.flatMap(({ state }) => check("events", refOf(id))(stateOf(state))),
              Effect.as({
                event: internals.kernel.decodeEvent(stored.event),
                envelope: decodeEnvelope(stored.envelope),
              }),
            ),
          ),
        ),
      );
    }
    return handlers;
  }) as Effect.Effect<Record<string, Handler>>;

// ---------------------------------------------------------------- client

type Flat = Record<string, (payload: unknown, options?: CallOptions) => unknown>;

/** Shape the flat Effect RPC client into commands plus view and aggregate namespaces. */
const nest = (entries: ReadonlyArray<Entry>, flat: Flat): unknown => {
  const client: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.kind === "Command") {
      client[entry.tag] = flat[entry.tag];
      continue;
    }
    const name = nameOf(entry);
    const call =
      (method: string) =>
      (key: unknown, options: CallOptions & Record<string, unknown> = {}) => {
        const { headers, ...rest } = options;
        return flat[`${name}.${method}`]!({ key, ...rest }, { headers });
      };
    client[name] =
      entry.kind === "View"
        ? { get: call("get"), watch: call("watch"), events: call("events"), list: call("list") }
        : { get: call("get"), watch: call("watch"), events: call("events") };
  }
  return client;
};

// A class so `class BankApi extends Api.make(...) {}` works.
const build = (
  name: string,
  entries: ReadonlyArray<Entry>,
  group: RpcGroup.RpcGroup<Rpc.Any>,
): unknown => {
  const client = RpcClient.make(group).pipe(
    Effect.map((flat) => nest(entries, flat as unknown as Flat)),
  );
  const Client = Context.Service<ClientKey<string>, unknown>()(`alchemy/Fold/Api/${name}/Client`);
  return Object.assign(class {}, {
    kind: "Api" as const,
    apiName: name,
    entries,
    group,
    middleware: (middleware: RpcMiddleware.AnyService) =>
      build(name, entries, group.middleware(middleware) as unknown as RpcGroup.RpcGroup<Rpc.Any>),
    httpEffect: Effect.gen(function* () {
      const handlers = yield* handlersOf(entries);
      // The middleware services (declared in `httpEffect`'s requirements), for every request.
      const middleware = yield* captureContext();
      const layer = Layer.mergeAll(
        group.toLayer(handlers as never),
        RpcSerialization.layerNdjson,
        Layer.succeedContext(middleware),
      );
      // One server per request: Workers forbid sharing I/O objects across requests.
      return RpcServer.toHttpEffect(group).pipe(
        Effect.flatten,
        Effect.provide(layer),
      ) as unknown as HttpEffect;
    }),
    client,
    Client,
    layerClient: Layer.effect(Client, client),
    testClient: Effect.gen(function* () {
      const handlers = yield* handlersOf(entries);
      const flat = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(group.toLayer(handlers as never)),
      );
      return nest(entries, flat as unknown as Flat);
    }),
  });
};

/**
 * Declare an Api: the public surface of a Domain for one client. Commands are
 * writes, sent to their aggregate after their middleware runs; views and
 * aggregates (with a `read` contract) are reads, judged by their `validate`.
 * Nothing needs a handler: aggregates implement commands, and the Domain
 * hosts views.
 *
 * The Api is built from contracts only, so it is safe to import in a
 * browser; the server provides the Domain and the middleware Layers.
 *
 * **Example:** Declaring an Api and calling it
 * ```typescript
 * export class BankApi extends Api.make("BankApi", OpenAccount, DepositMoney, Account, AccountSummary) {}
 *
 * export const followBalance = Effect.fn(function* (accountId: AccountId) {
 *   const bank = yield* BankApi.Client;
 *   yield* bank.DepositMoney({ target: accountId, amount: 1_000 });
 *   yield* bank.AccountSummary.watch(accountId).pipe(
 *     Stream.runForEach((summary) => Effect.log(summary?.balance)),
 *   );
 * });
 * ```
 */
export const make = <const Name extends string, const Entries extends ReadonlyArray<Entry>>(
  name: Name,
  ...entries: Entries
): ApiClass<Name, Entries> =>
  build(
    name,
    entries,
    RpcGroup.make(...entries.flatMap(rpcsOf)) as unknown as RpcGroup.RpcGroup<Rpc.Any>,
  ) as ApiClass<Name, Entries>;

/**
 * The HTTP protocol for an Api client (NDJSON, so streams work). Requires an
 * `HttpClient`, e.g. `FetchHttpClient.layer`.
 */
export const protocolHttp = (
  url: string,
): Layer.Layer<RpcClient.Protocol, never, HttpClient.HttpClient> =>
  RpcClient.layerProtocolHttp({ url }).pipe(Layer.provide(RpcSerialization.layerNdjson));
