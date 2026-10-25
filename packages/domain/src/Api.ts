import type { HttpEffect } from "alchemy/Http";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Exit from "effect/Exit";
import type * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMessage from "effect/rpc/RpcMessage";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import type * as Aggregate from "./Aggregate.ts";
import * as Command from "./Command.ts";
import type * as Event from "./Event.ts";
import { type Filter, matches } from "./Filter.ts";
import { captureContext } from "./internal.ts";
import { decodeEnvelope } from "./Kernel.ts";
import * as Middleware from "./Middleware.ts";
import * as Model from "./Model.ts";
import type { AggregateStore, StreamStore, Subscription, ViewStore } from "./Platform.ts";
import type * as Read from "./Read.ts";
import { contractOf, nameOf, readRpcs } from "./ReadRpcs.ts";
import * as RequestContext from "./RequestContext.ts";
import type * as DomainStream from "./Stream.ts";
import type * as View from "./View.ts";
import * as Watch from "./Watch.ts";

/**
 * What an Api exposes: commands (writes); views, streams, and aggregates that
 * declare a `read` contract (reads).
 */
export type Entry = Command.Any | View.Any | Aggregate.Any | DomainStream.Any;

type Commands<E extends Entry> = Extract<E, Command.Any>;
type Views<E extends Entry> = Extract<E, View.Any>;
type Streams<E extends Entry> = Extract<E, DomainStream.Any>;
type Aggregates<E extends Entry> = Exclude<E, Command.Any | View.Any | DomainStream.Any>;

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

/** The typed client of a stream exposed in an Api. */
export interface StreamClient<S extends DomainStream.Any> {
  /** The key's latest entry, or `null` if nothing was appended. */
  readonly peek: (
    key: Aggregate.IdOf<DomainStream.KeyOf<S>>,
    options?: CallOptions & {
      /** Wait until the stream's writer has handled this write (a command's `stream` and `version`). */
      readonly atLeast?: { readonly stream: string; readonly version: number };
    },
  ) => Effect.Effect<
    DomainStream.Entry<DomainStream.EventOf<S>, Aggregate.IdOf<DomainStream.KeyOf<S>>> | null,
    ReadError<S["definition"]>
  >;
  /** The key's latest entry, then each new one. Ends with a rejection when `validate` stops allowing it. */
  readonly watch: (
    key: Aggregate.IdOf<DomainStream.KeyOf<S>>,
    options?: CallOptions,
  ) => Stream.Stream<
    DomainStream.Entry<DomainStream.EventOf<S>, Aggregate.IdOf<DomainStream.KeyOf<S>>> | null,
    ReadError<S["definition"]>
  >;
  /** The key's entries from `after` (an entry `seq`), then live ones. */
  readonly events: (
    key: Aggregate.IdOf<DomainStream.KeyOf<S>>,
    options?: CallOptions & {
      readonly after?: number;
      readonly where?: Filter<DomainStream.EventOf<S>>;
    },
  ) => Stream.Stream<
    DomainStream.Entry<DomainStream.EventOf<S>, Aggregate.IdOf<DomainStream.KeyOf<S>>>,
    ReadError<S["definition"]>
  >;
  /** A page of the key's entries. */
  readonly list: (
    key: Aggregate.IdOf<DomainStream.KeyOf<S>>,
    options?: CallOptions & {
      readonly where?: Filter<DomainStream.EventOf<S>>;
      readonly order?: "asc" | "desc";
      readonly take?: number;
      readonly after?: string;
    },
  ) => Effect.Effect<
    View.Page<DomainStream.Entry<DomainStream.EventOf<S>, Aggregate.IdOf<DomainStream.KeyOf<S>>>>,
    ReadError<S["definition"]>
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
export type ApiClient<E extends Entry> = RpcClient.RpcClient<
  Commands<E>["rpc"],
  RpcClientError.RpcClientError
> & {
  readonly [V in Views<E> as V["viewName"]]: ViewClient<V>;
} & {
  readonly [S in Streams<E> as S["streamName"]]: StreamClient<S>;
} & {
  readonly [A in Aggregates<E> as A["aggregateName"]]: AggregateClient<A>;
};

/** Type-level identity of an Api's client service. */
export interface ClientKey<Name extends string> {
  readonly "~alchemy/Domain/Api/Client": Name;
}

/** What `yield* MyApi` gives a Worker: the Api served over HTTP. */
export interface ApiServer {
  /** Use as the Worker's `fetch`. Commands and reads over HTTP; live reads over WebSockets. */
  readonly fetch: HttpEffect;
}

/**
 * The class type returned by {@link make}. The class is itself an Effect:
 * `yield* MyApi` serves it, requiring the hosted Domain and the Layers of every
 * middleware its entries declare.
 */
export interface ApiClass<
  Name extends string,
  Entries extends ReadonlyArray<Entry>,
> extends Effect.Effect<ApiServer, never, Model.Internals | MiddlewareServices<Entries>> {
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
  /** A typed client. Provide a protocol: {@link protocolWebSocket} or {@link protocolHttp}. */
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
    Scope.Scope | Model.Internals | MiddlewareServices<Entries> | MiddlewareClients<Entries>
  >;
}

type EntryMiddleware<E> = E extends Command.Any
  ? E["middleware"][number]
  : E extends View.Any | DomainStream.Any
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
    const internals = yield* Model.Internals;
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

      if (entry.kind === "Stream") {
        const host = internals.streamHosts.get(name)!;
        const key = entry.definition.key;
        const refOf = (id: string) => ({ aggregate: key.aggregateName, id }) as Aggregate.Ref;
        const latest = (id: string) =>
          host.peek(refOf(id)).pipe(Effect.orDie, Effect.map(Option.getOrNull));
        handlers[`${name}.peek`] = effect(rpcs.get, ({ key: id, atLeast }) =>
          host.peek(refOf(id), { atLeast }).pipe(
            Effect.orDie,
            Effect.flatMap((found) => {
              const entry = Option.getOrNull(found);
              return check("get", refOf(id))(entry).pipe(Effect.as(entry));
            }),
          ),
        );
        handlers[`${name}.watch`] = stream(rpcs.watch, ({ key: id }) =>
          host.watch(refOf(id)).pipe(
            Stream.mapEffect((found) => {
              const entry = Option.getOrNull(found);
              return check("watch", refOf(id))(entry).pipe(Effect.as(entry));
            }),
          ),
        );
        handlers[`${name}.events`] = stream(rpcs.events, ({ key: id, after, where }) =>
          host
            .events(refOf(id), {
              after: after === undefined ? undefined : Number(after),
              where: where as Filter<unknown> | undefined,
            })
            .pipe(
              // Each entry is judged as the key's latest entry at that point.
              Stream.mapEffect((entry) => check("events", refOf(id))(entry).pipe(Effect.as(entry))),
            ),
        );
        handlers[`${name}.list`] = effect(rpcs.list!, ({ key: id, where, order, take, after }) =>
          latest(id).pipe(
            Effect.flatMap((entry) => check("list", refOf(id))(entry)),
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

// ---------------------------------------------------------------- live reads

/** The query parameter carrying a live read's request (a WebSocket upgrade cannot carry a body). */
const LIVE_PARAM = "read";

/**
 * A live read as the client sends it: the Effect RPC request's id, tag and
 * payload, plus the cursor to resume from after a reconnect. Never headers:
 * a URL ends up in logs, so a live read authenticates with what its upgrade
 * request carries (in a browser, its cookies).
 */
interface LiveRequest {
  readonly id: string | number;
  readonly tag: string;
  readonly payload: unknown;
  readonly cursor?: number;
  /** The client's span, as the RPC protocol carries it, so the read joins the caller's trace. */
  readonly traceId?: string;
  readonly spanId?: string;
  readonly sampled?: boolean;
}

/**
 * Serve live reads (`watch` and `events`) as WebSockets. The read's
 * middleware runs here, in the Worker, against the upgrade request's own
 * headers (cookies, in a browser); the context it provides travels with
 * the subscription to the object that owns the key, which pushes to the
 * socket on every commit. A refused read still connects, to deliver its
 * typed rejection.
 */
const liveReads = (
  entries: ReadonlyArray<Entry>,
  internals: Model.Internals["Service"],
  middleware: Context.Context<never>,
) => {
  const reads = new Map<
    string,
    {
      readonly rpc: Rpc.AnyWithProps;
      readonly mode: "watch" | "events";
      readonly store?: AggregateStore | ViewStore | StreamStore;
    }
  >();
  for (const entry of entries) {
    if (entry.kind === "Command") continue;
    const name = nameOf(entry);
    const store =
      entry.kind === "View"
        ? internals.views.get(name)
        : entry.kind === "Stream"
          ? internals.streams.get(name)
          : internals.aggregates.get(name);
    const rpcs = readRpcs(entry);
    reads.set(`${name}.watch`, { rpc: rpcs.watch as Rpc.AnyWithProps, mode: "watch", store });
    reads.set(`${name}.events`, { rpc: rpcs.events as Rpc.AnyWithProps, mode: "events", store });
  }
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const raw = new URL(request.url, "http://localhost").searchParams.get(LIVE_PARAM);
    const live = raw === null ? undefined : (JSON.parse(raw) as LiveRequest);
    const read = live && reads.get(live.tag);
    if (!live || !read) return HttpServerResponse.text("Unknown live read", { status: 400 });
    if (!read.store?.connect) {
      return HttpServerResponse.text("This platform streams live reads as responses", {
        status: 501,
      });
    }
    const payload = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(read.rpc.payloadSchema))(
      live.payload,
    ).pipe(Effect.option);
    if (Option.isNone(payload))
      return HttpServerResponse.text("Invalid live read", { status: 400 });
    const { key, where, after } = payload.value as ReadPayload;
    yield* Effect.annotateCurrentSpan({ "domain.read": live.tag, "domain.key": String(key) });
    // Run the read's middleware, as the RPC server would, around capturing what it provides.
    let authorized: Effect.Effect<RequestContext.Json, unknown> = RequestContext.capture;
    for (const service of read.rpc.middlewares) {
      const run = Context.getUnsafe(middleware, service) as unknown as (
        effect: Effect.Effect<RequestContext.Json, unknown>,
        options: unknown,
      ) => Effect.Effect<RequestContext.Json, unknown>;
      authorized = run(authorized, {
        rpc: read.rpc,
        client: new Rpc.ServerClient(0),
        requestId: RpcMessage.RequestId(live.id),
        headers: request.headers,
        payload: payload.value,
      });
    }
    const subscription: Subscription = {
      requestId: live.id,
      mode: read.mode,
      where: where as Subscription["where"],
      context: {},
      cursor: live.cursor ?? (read.mode === "watch" ? -1 : after === undefined ? 0 : Number(after)),
    };
    const judged = yield* authorized.pipe(
      Effect.map((context): Subscription => ({ ...subscription, context })),
      Effect.catch((error) =>
        Watch.refuse(read.rpc, error).pipe(
          Effect.orDie,
          Effect.map((refused): Subscription => ({ ...subscription, refused })),
        ),
      ),
    );
    return yield* read.store.connect(String(key), judged);
  }).pipe(
    // A live read continues the trace of the client that opened it, like an RPC call.
    (effect) =>
      Effect.flatMap(HttpServerRequest, (request) => {
        const raw = new URL(request.url, "http://localhost").searchParams.get(LIVE_PARAM);
        const live = raw === null ? undefined : (JSON.parse(raw) as LiveRequest);
        return effect.pipe(
          Effect.withSpan(`Domain.read ${live?.tag ?? "unknown"}`, {
            kind: "server",
            ...(live?.traceId && live.spanId
              ? {
                  parent: Tracer.externalSpan({
                    traceId: live.traceId,
                    spanId: live.spanId,
                    sampled: live.sampled ?? true,
                  }),
                }
              : {}),
          }),
        );
      }),
  );
};

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
        : entry.kind === "Stream"
          ? { peek: call("peek"), watch: call("watch"), events: call("events"), list: call("list") }
          : { get: call("get"), watch: call("watch"), events: call("events") };
  }
  return client;
};

// A class so `class BankApi extends Domain.Api(...) {}` works.
const build = (
  name: string,
  entries: ReadonlyArray<Entry>,
  group: RpcGroup.RpcGroup<Rpc.Any>,
): unknown => {
  const client = RpcClient.make(group).pipe(
    Effect.map((flat) => nest(entries, flat as unknown as Flat)),
  );
  const Client = Context.Service<ClientKey<string>, unknown>()(`alchemy/Domain/Api/${name}/Client`);
  // Serve the Api over HTTP (Effect RPC, NDJSON), with live reads over WebSockets.
  const serve = Effect.gen(function* () {
    const handlers = yield* handlersOf(entries);
    // The middleware services (declared in the Api's requirements), for every request.
    const middleware = yield* captureContext();
    const layer = Layer.mergeAll(
      group.toLayer(handlers as never),
      RpcSerialization.layerNdjson,
      Layer.succeedContext(middleware),
    );
    // One server per request: Workers forbid sharing I/O objects across requests.
    const rpc = RpcServer.toHttpEffect(group).pipe(Effect.flatten, Effect.provide(layer));
    const live = liveReads(entries, yield* Model.Internals, middleware);
    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      return request.headers.upgrade?.toLowerCase() === "websocket" ? yield* live : yield* rpc;
    }) as unknown as HttpEffect;
    return { fetch };
  });
  return Object.assign(
    class {},
    // The class is an Effect: `yield* MyApi` serves it.
    Effectable.Prototype({ label: `alchemy/Domain/Api<${name}>`, evaluate: () => serve }),
    {
      kind: "Api" as const,
      apiName: name,
      entries,
      group,
      middleware: (middleware: RpcMiddleware.AnyService) =>
        build(name, entries, group.middleware(middleware) as unknown as RpcGroup.RpcGroup<Rpc.Any>),
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
    },
  );
};

/**
 * The public surface of a domain for one kind of client: the commands it may
 * send, and the views and aggregates (with a `read` contract) it may read.
 * Nothing in an Api needs a handler. The class is an Effect: `yield* MyApi`
 * gives a Worker its `fetch`. Call it with a typed client over
 * `Domain.protocolWebSocket` or `Domain.protocolHttp`.
 *
 * ### Declaring an Api
 * **Example:** What customers may reach
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { Account, DepositMoney, WithdrawMoney } from "./Account.ts";
 * import { AccountSummary } from "./AccountSummary.ts";
 *
 * export class CustomerApi extends Domain.Api(
 *   "CustomerApi",
 *   DepositMoney,
 *   WithdrawMoney,
 *   Account,
 *   AccountSummary,
 * ) {}
 * ```
 *
 * ### Serving it from a Worker
 * **Example:** The Api as a Worker's fetch
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 * import { CustomerApi } from "./CustomerApi.ts";
 * import { SessionLive } from "./Session.ts";
 *
 * const BankLive = SessionLive.pipe(
 *   Layer.provideMerge(Bank.layer(BankPolicies)),
 *   Layer.provide(DomainCloudflare.DurableObjects),
 * );
 *
 * export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
 *   "BankWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* CustomerApi;
 *     return { fetch: api.fetch };
 *   }).pipe(Effect.provide(BankLive)),
 * ) {}
 * ```
 *
 * ### Calling it
 * `Domain.protocolWebSocket` sends commands, `get` and `list` over HTTP, and
 * opens a WebSocket for each `watch` and `events`, pushed by the object that
 * owns the key. `Domain.protocolHttp` sends everything over HTTP.
 *
 * **Example:** A typed client
 * ```typescript
 * const bank = yield* CustomerApi.client;
 * const { reply } = yield* bank.DepositMoney({ target: accountId, amount: 1_000 });
 * const summary = yield* bank.AccountSummary.get(accountId);
 * yield* bank.AccountSummary.watch(accountId).pipe(
 *   Stream.runForEach((s) => Effect.log(s?.balance)),
 * );
 * ```
 *
 * @primitive
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
 * The HTTP protocol for an Api client (NDJSON, so streams work). Live reads
 * are streamed responses, which the platform feeds by polling the key; use
 * {@link protocolWebSocket} to have them pushed instead. Requires an
 * `HttpClient`, e.g. `FetchHttpClient.layer`.
 */
export const protocolHttp = (
  url: string,
): Layer.Layer<RpcClient.Protocol, never, HttpClient.HttpClient> =>
  RpcClient.layerProtocolHttp({ url }).pipe(Layer.provide(RpcSerialization.layerNdjson));

/** A frame of a live read: an Effect RPC message, plus the cursor to resume from. */
type LiveFrame = RpcMessage.FromServerEncoded & { readonly cursor?: number };

/** The RPCs served as live reads. */
const isLiveRead = (tag: string) => tag.endsWith(".watch") || tag.endsWith(".events");

/** Attempts in a row a live read may fail to (re)connect before it fails. */
const RECONNECTS = 8;

/**
 * The WebSocket protocol for an Api client. Calls (commands, `get`, `list`)
 * go over HTTP like {@link protocolHttp}; every live read (`watch`,
 * `events`) opens its own WebSocket, which the Api hands to the object that
 * owns the key (on Cloudflare, its Durable Object). Each commit is pushed
 * down the socket, so nothing polls and the object hibernates in between. A
 * dropped socket reconnects and resumes after the last value it delivered.
 *
 * A browser cannot set headers on a WebSocket, and a URL ends up in logs,
 * so headers client middleware attaches apply to calls only. A live read
 * authenticates with what its upgrade request carries: in a browser, the
 * cookies of the Api's origin, so serve the app and the Api from one origin
 * and keep sessions in an `HttpOnly`, `SameSite` cookie. Requires an
 * `HttpClient` and a `Socket.WebSocketConstructor`
 * (`Socket.layerWebSocketConstructorGlobal` in browsers and Workers).
 *
 * **Example:** Watching a view over a WebSocket
 * ```typescript
 * const BankConnection = CustomerApi.layerClient.pipe(
 *   Layer.provide(Domain.protocolWebSocket("https://bank.example.com/api")),
 *   Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
 * );
 * ```
 */
export const protocolWebSocket = (
  url: string,
): Layer.Layer<RpcClient.Protocol, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =>
  Layer.effect(
    RpcClient.Protocol,
    Effect.gen(function* () {
      const client = HttpClient.mapRequest(
        yield* HttpClient.HttpClient,
        HttpClientRequest.prependUrl(url),
      );
      const http = yield* RpcClient.makeProtocolHttp(client).pipe(
        Effect.provide(RpcSerialization.layerNdjson),
      );
      const constructor = yield* Socket.WebSocketConstructor;
      const socketUrl = url.replace(/^http/, "ws");
      const writers = new Map<
        number,
        (message: RpcMessage.FromServerEncoded) => Effect.Effect<void>
      >();
      const stops = new Map<string, Deferred.Deferred<void>>();

      const liveRead = (clientId: number, request: RpcMessage.RequestEncoded) =>
        Effect.gen(function* () {
          let cursor: number | undefined;
          let ended = false;
          let failures = 0;
          const connect = Effect.gen(function* () {
            const live: LiveRequest = {
              id: request.id,
              tag: request.tag,
              payload: request.payload,
              cursor,
              ...(request.traceId && request.spanId
                ? { traceId: request.traceId, spanId: request.spanId, sampled: request.sampled }
                : {}),
            };
            const socket = yield* Socket.makeWebSocket(
              `${socketUrl}?${LIVE_PARAM}=${encodeURIComponent(JSON.stringify(live))}`,
            );
            const pull = yield* Socket.readerString(socket);
            while (!ended) {
              for (const text of yield* pull) {
                const { cursor: next, ...message } = JSON.parse(text) as LiveFrame;
                failures = 0;
                if (next !== undefined) cursor = next;
                if (message._tag === "Exit") ended = true;
                yield* Effect.suspend(
                  () =>
                    writers.get(clientId)?.(message as RpcMessage.FromServerEncoded) ?? Effect.void,
                );
              }
            }
          }).pipe(Effect.scoped, Effect.provideService(Socket.WebSocketConstructor, constructor));

          while (!ended) {
            const exit = yield* Effect.exit(connect);
            if (ended) return;
            // A close without an `Exit` (a deploy, an evicted object) reconnects and resumes.
            if (++failures > RECONNECTS) {
              return yield* new RpcClientError.RpcClientError({
                reason: new RpcClientError.RpcClientDefect({
                  message: `Live read ${request.tag} lost its connection`,
                  cause: Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
                }),
              });
            }
            yield* Effect.sleep(Duration.millis(Math.min(5_000, 100 * 2 ** failures)));
          }
        });

      return RpcClient.Protocol.of({
        run: (clientId, write) =>
          Effect.suspend(() => {
            writers.set(clientId, write);
            return http.run(clientId, write);
          }).pipe(Effect.ensuring(Effect.sync(() => writers.delete(clientId)))),
        send: (clientId, request, transferables) => {
          if (request._tag === "Request" && isLiveRead(request.tag)) {
            return Effect.gen(function* () {
              const stop = yield* Deferred.make<void>();
              stops.set(String(request.id), stop);
              yield* Effect.raceFirst(liveRead(clientId, request), Deferred.await(stop)).pipe(
                Effect.ensuring(Effect.sync(() => stops.delete(String(request.id)))),
              );
            });
          }
          if (request._tag === "Interrupt") {
            const stop = stops.get(String(request.requestId));
            if (stop) return Deferred.succeed(stop, undefined).pipe(Effect.asVoid);
          }
          return http.send(clientId, request, transferables);
        },
        supportsAck: false,
        supportsTransferables: false,
        codecFor: http.codecFor,
      });
    }),
  );

// ---------------------------------------------------------------- surfaces

/**
 * The surfaces built from an Api that may publish an entry, as an entry
 * declares them in `expose`. Each flag is optional; {@link exposureOf} fills
 * in the defaults. The Api's own clients (RPC, `client`, `testClient`) serve
 * every entry, whatever `expose` says.
 */
export interface Expose {
  /** A tool or resource on an MCP server built from the Api. Default `true`. */
  readonly mcp?: boolean;
  /** A command of a CLI built from the Api. Default `true`. */
  readonly cli?: boolean;
  /**
   * A path of a public HTTP API (and its OpenAPI document) built from the
   * Api. Default `false`: once a client calls a public path, it has to stay.
   */
  readonly http?: boolean;
}

/** Where an entry is published, with every default filled in. */
export interface Exposure {
  readonly mcp: boolean;
  readonly cli: boolean;
  readonly http: boolean;
}

/** Where an entry declares its `expose`: a command's options, or its read contract. */
const exposeOf = (entry: Entry): Expose | undefined =>
  entry.kind === "Command"
    ? entry.expose
    : entry.kind === "Aggregate"
      ? entry.definition.read?.expose
      : entry.definition.expose;

/**
 * The surfaces that may publish an Api entry: what its `expose` declares,
 * with the defaults for the rest. MCP and the CLI default to `true`, and a
 * public HTTP API to `false`. Exposure is not permission: an entry on a
 * surface still runs its middleware on every call.
 *
 * **Example:** A command published on MCP, but not on the CLI
 * ```typescript
 * export class UnlockDoor extends Domain.Command("UnlockDoor", {
 *   target: DoorId,
 *   expose: { cli: false },
 * }) {}
 *
 * Domain.exposureOf(UnlockDoor); // { mcp: true, cli: false, http: false }
 * ```
 */
export const exposureOf = (entry: Entry): Exposure => {
  const expose = exposeOf(entry);
  return {
    mcp: expose?.mcp ?? true,
    cli: expose?.cli ?? true,
    http: expose?.http ?? false,
  };
};
