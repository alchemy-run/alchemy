import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { WorkflowEngine } from "effect/workflow";
import * as Aggregate from "./Aggregate.ts";
import { matches } from "./Filter.ts";
import * as Kernel from "./Kernel.ts";
import type * as Key from "./Key.ts";
import {
  type Accepted,
  type AggregateStore,
  type Delivery,
  Platform,
  type PolicyStore,
  type ProjectionStore,
  type StoredEvent,
  type StreamEntry,
  type StreamMeta,
  type StreamStore,
  type ViewSnapshot,
  type ViewStore,
} from "./Platform.ts";
import type * as Policy from "./Policy.ts";
import * as Projection from "./Projection.ts";
import * as Query from "./Query.ts";
import * as RequestContext from "./RequestContext.ts";
import * as Saga from "./Saga.ts";
import type * as DomainStream from "./Stream.ts";
import * as Telemetry from "./Telemetry.ts";
import * as View from "./View.ts";
import * as Watch from "./Watch.ts";

type Identifier<T> = T extends Context.Key<infer I, unknown> ? I : never;

/**
 * Low-level access to a built Model's kernel and stores (story runner,
 * diagnostics).
 *
 * @internal
 */
export class Internals extends Context.Service<
  Internals,
  {
    readonly kernel: Kernel.Kernel;
    readonly aggregates: ReadonlyMap<string, AggregateStore>;
    readonly views: ReadonlyMap<string, ViewStore>;
    readonly streams: ReadonlyMap<string, StreamStore>;
    /** The client of the aggregate that handles each command, by command tag. */
    readonly commands: ReadonlyMap<string, Aggregate.ClientImpl>;
    /** Each view's read API, by view name. */
    readonly viewHosts: ReadonlyMap<string, View.Host<unknown, Key.Any, unknown>>;
    /** Each stream's API, by stream name. */
    readonly streamHosts: ReadonlyMap<string, DomainStream.Host<Key.Any, unknown>>;
    /** Each query, hosted, by query name. */
    readonly queries: ReadonlyMap<string, Query.Host>;
  }
>()("alchemy/Domain/ModelInternals") {}

/**
 * The entities that make up a Model.
 */
export interface Members<
  A extends ReadonlyArray<Aggregate.Any>,
  V extends ReadonlyArray<View.Any>,
  P extends ReadonlyArray<Policy.Any>,
  J extends ReadonlyArray<Projection.Any>,
  S extends ReadonlyArray<DomainStream.Any>,
  G extends ReadonlyArray<Saga.Any> = readonly [],
  Q extends ReadonlyArray<Query.Any> = readonly [],
> {
  readonly aggregates: A;
  readonly views?: V;
  readonly policies?: P;
  readonly projections?: J;
  readonly streams?: S;
  readonly sagas?: G;
  /** The queries it answers, from the stores its projections write. */
  readonly queries?: Q;
}

/**
 * The class type returned by {@link make}.
 *
 * `Provided` is every aggregate, view, stream and projection-progress service
 * the Model provides; `Policies` is every policy, projection and query whose
 * implementation `layer` requires; `Missing` is any member a query reads that
 * the Model does not host.
 */
export interface ModelClass<Name extends string, Provided, Policies, Missing = never> {
  new (_: never): {};
  readonly kind: "Model";
  readonly modelName: Name;
  readonly definitions: Kernel.Definitions;
  /**
   * Host every entity on the ambient {@link Platform}. The policy and
   * projection Layers (`handlers`) are built after the aggregates, views and
   * streams exist, so a handler can resolve them while it is constructed.
   * `options` tune how it's hosted, such as what it records in traces.
   */
  layer<E = never, R = never>(
    handlers: Layer.Layer<Policies, E, R>,
    options?: LayerOptions,
  ): Layer.Layer<Provided | Internals, E, Platform | Exclude<R, Provided> | Missing>;
}

/**
 * Structural constraint satisfied by every Model class.
 */
export interface Any {
  readonly kind: "Model";
  readonly modelName: string;
  readonly definitions: Kernel.Definitions;
}

type ProvidedBy<
  A extends ReadonlyArray<Aggregate.Any>,
  V extends ReadonlyArray<View.Any>,
  J extends ReadonlyArray<Projection.Any>,
  S extends ReadonlyArray<DomainStream.Any>,
  G extends ReadonlyArray<Saga.Any>,
> =
  | Identifier<A[number]>
  | Identifier<V[number]>
  | Identifier<S[number]>
  | Saga.Identifier<G[number]>
  | Projection.ProgressIdentifier<J[number]>;

/** How a model's `layer` hosts it: tuning that doesn't change what the model means. */
export interface LayerOptions {
  /** What the hosted model records in traces. See {@link Telemetry.Options}. */
  readonly telemetry?: Telemetry.Options;
}

/** Every implementation a model's `layer` requires: its policies, projections, sagas and queries. */
type HandledBy<
  P extends ReadonlyArray<Policy.Any>,
  J extends ReadonlyArray<Projection.Any>,
  G extends ReadonlyArray<Saga.Any>,
  Q extends ReadonlyArray<Query.Any> = readonly [],
> =
  | Identifier<P[number]>
  | Identifier<J[number]>
  | Saga.ImplementationIdentifier<G[number]>
  | Query.Identifier<Q[number]>;

/**
 * The aggregates, views and policies you host together. `layer(policies)`
 * builds them all on the Platform you provide, and provides each aggregate
 * and view as a service.
 *
 * ### Declaring and hosting a model
 * **Example:** In memory, with its policies and external systems
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Layer from "effect/Layer";
 * import { Account } from "./Account.ts";
 * import { AccountSummary } from "./AccountSummary.ts";
 * import { Customer } from "./Customer.ts";
 * import { MainAccountProvisioning, MainAccountProvisioningLive } from "./MainAccountProvisioning.ts";
 *
 * export class Bank extends Domain.Model("Bank", {
 *   aggregates: [Account, Customer],
 *   views: [AccountSummary],
 *   policies: [MainAccountProvisioning],
 * }) {}
 *
 * export const BankInMemory = Bank.layer(MainAccountProvisioningLive).pipe(
 *   Layer.provide(Domain.InMemory),
 * );
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  const A extends ReadonlyArray<Aggregate.Any>,
  const V extends ReadonlyArray<View.Any> = readonly [],
  const P extends ReadonlyArray<Policy.Any> = readonly [],
  const J extends ReadonlyArray<Projection.Any> = readonly [],
  const S extends ReadonlyArray<DomainStream.Any> = readonly [],
  const G extends ReadonlyArray<Saga.Any> = readonly [],
  const Q extends ReadonlyArray<Query.Any> = readonly [],
>(
  name: Name,
  members: Members<A, V, P, J, S, G, Q>,
): ModelClass<
  Name,
  ProvidedBy<A, V, J, S, G>,
  HandledBy<P, J, G, Q>,
  Exclude<Query.NeedsOf<Q[number]>, ProvidedBy<A, V, J, S, G>>
> => {
  const definitions: Kernel.Definitions = {
    aggregates: members.aggregates,
    views: members.views ?? [],
    policies: members.policies ?? [],
    projections: members.projections ?? [],
    streams: members.streams ?? [],
  };
  return class {
    static readonly kind = "Model" as const;
    static readonly modelName: Name = name;
    static readonly definitions: Kernel.Definitions = definitions;
    static readonly sagas: ReadonlyArray<Saga.Any> = members.sagas ?? [];
    static readonly queries: ReadonlyArray<Query.Any> = members.queries ?? [];
    static layer<E, R>(handlers: Layer.Layer<HandledBy<P, J, G, Q>, E, R>, options?: LayerOptions) {
      return Layer.effectContext(
        build(
          definitions,
          handlers,
          members.sagas ?? [],
          members.queries ?? [],
          Telemetry.resolve(options?.telemetry),
        ),
      );
    }
  } as unknown as ModelClass<
    Name,
    ProvidedBy<A, V, J, S, G>,
    HandledBy<P, J, G, Q>,
    Exclude<Query.NeedsOf<Q[number]>, ProvidedBy<A, V, J, S, G>>
  >;
};

/**
 * Check a Model's definitions without hosting it: every problem that would
 * otherwise fail its Layer's build, such as a view consuming a source keyed
 * by another aggregate without `keyOf`, a view with `state` but no
 * `initial`, a policy listening for an event no source emits, or a stream
 * with two writers. Returns all of them, in definition order; an empty
 * array means the Model is valid. Problems that depend on what a handler
 * returns, such as `decide` returning an event its command does not
 * declare, still surface when the handler runs.
 *
 * **Example:** A unit test for the whole Model
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { expect, it } from "vitest";
 * import { Bank } from "./Bank.model.ts";
 *
 * it("the model is well defined", () => {
 *   expect(Domain.verify(Bank)).toEqual([]);
 * });
 * ```
 */
export const verify = (model: Any): ReadonlyArray<Kernel.DefinitionError> =>
  Kernel.verify(model.definitions);

/**
 * Trace one projection batch. A batch merges events from many commits, so it
 * starts its own trace and links to each event's.
 */
const observeProjection =
  (name: string, key: string, batch: ReadonlyArray<Accepted>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const tags = { "domain.kind": "projection", "domain.consumer": name };
    const links = batch.flatMap(({ delivery }) =>
      delivery.envelope.trace
        ? [{ span: Telemetry.spanOf(delivery.envelope.trace), attributes: {} }]
        : [],
    );
    const correlations = [
      ...new Set(
        batch.map(({ delivery }) => delivery.envelope.correlationId ?? delivery.envelope.commandId),
      ),
    ];
    return effect.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const now = yield* Effect.sync(() => Date.now());
          for (const { delivery } of batch) {
            yield* Telemetry.record(Telemetry.lag, tags, now - delivery.envelope.at);
          }
          yield* Telemetry.record(Telemetry.batchSize, { "domain.consumer": name }, batch.length);
          yield* Telemetry.record(Telemetry.runs, {
            ...tags,
            "domain.outcome": Exit.isSuccess(exit) ? "ok" : "failed",
          });
        }),
      ),
      Effect.withSpan(`Domain.projection ${name}`, {
        kind: "consumer",
        root: true,
        links,
        attributes: {
          "domain.projection": name,
          "domain.key": key,
          "domain.batch": batch.length,
          ...(correlations.length === 1 ? { "domain.correlation_id": correlations[0] } : {}),
        },
      }),
    );
  };

const build = <A, E, R>(
  definitions: Kernel.Definitions,
  policies: Layer.Layer<A, E, R>,
  sagas: ReadonlyArray<Saga.Any>,
  queries: ReadonlyArray<Query.Any>,
  telemetry: Telemetry.Resolved,
) =>
  Effect.gen(function* () {
    const platform = yield* Platform;
    const kernel = yield* Kernel.make(definitions, telemetry);

    const aggregateStores = new Map<string, AggregateStore>();
    const viewStores = new Map<string, ViewStore>();
    const policyStores = new Map<string, PolicyStore>();
    const projectionStores = new Map<string, ProjectionStore>();
    const streamStores = new Map<string, StreamStore>();

    const deliver = (delivery: Delivery): Effect.Effect<void> =>
      Effect.suspend(() => {
        const { kind, name } = delivery.target;
        if (kind === "view") return viewStores.get(name)!.receive(delivery.key, [delivery]);
        const store = kind === "policy" ? policyStores.get(name) : projectionStores.get(name);
        return store
          ? store.receive(delivery)
          : Effect.die(new Error(`${kind} ${name} is not hosted yet`));
      });

    for (const aggregate of definitions.aggregates) {
      aggregateStores.set(
        aggregate.aggregateName,
        yield* platform.aggregate(aggregate, {
          ...kernel.aggregateKit(aggregate, deliver),
          push: Watch.aggregatePush(kernel, aggregate),
        }),
      );
    }
    for (const view of definitions.views) {
      viewStores.set(
        view.viewName,
        yield* platform.view(view, {
          ...kernel.viewKit(view, deliver),
          push: Watch.viewPush(kernel, view),
        }),
      );
    }

    for (const stream of definitions.streams) {
      streamStores.set(
        stream.streamName,
        yield* platform.stream(stream, {
          name: stream.streamName,
          push: Watch.streamPush(kernel, stream),
        }),
      );
    }

    let hosts = Context.empty() as Context.Context<unknown>;
    const commands = new Map<string, Aggregate.ClientImpl>();
    for (const aggregate of definitions.aggregates) {
      const client = aggregateClient(
        kernel,
        aggregate,
        aggregateStores.get(aggregate.aggregateName)!,
      );
      hosts = Context.add(hosts, aggregate, client);
      for (const command of aggregate.definition.commands) commands.set(command.tag, client);
    }
    const viewHosts = new Map<string, View.Host<unknown, Key.Any, unknown>>();
    for (const view of definitions.views) {
      const host = viewHost(kernel, view, viewStores.get(view.viewName)!);
      viewHosts.set(view.viewName, host);
      hosts = Context.add(hosts, view, host);
    }
    const streamHosts = new Map<string, DomainStream.Host<Key.Any, unknown>>();
    for (const stream of definitions.streams) {
      const host = streamHost(kernel, stream, streamStores.get(stream.streamName)!);
      streamHosts.set(stream.streamName, host);
      hosts = Context.add(hosts, stream, host);
    }
    for (const projection of definitions.projections) {
      hosts = Context.add(
        hosts,
        projection.Progress,
        projectionProgress(
          kernel,
          projection,
          () => projectionStores.get(projection.projectionName)!,
          aggregateStores,
        ),
      );
    }

    // Sagas run on the platform's workflow engine.
    if (sagas.length > 0) {
      const engine = yield* Effect.serviceOption(WorkflowEngine.WorkflowEngine);
      if (Option.isNone(engine)) {
        return yield* Effect.die(
          new Kernel.DefinitionError(
            `${sagas.map((saga) => saga.sagaName).join(", ")} need a platform that runs workflows`,
          ),
        );
      }
      for (const saga of sagas) hosts = Context.add(hosts, saga, Saga.client(saga, engine.value));
    }

    // Policies, projections and sagas are built with the clients available, then hosted.
    const implementations = yield* Layer.build(policies).pipe(Effect.provide(hosts));
    for (const projection of definitions.projections) {
      const implementation = Context.getUnsafe(
        implementations as Context.Context<unknown>,
        projection as Context.Key<unknown, Projection.Implementation<unknown>>,
      );
      const writes = (projection.definition.writes ?? []).map((stream) =>
        streamStores.get(stream.streamName)!,
      );
      projectionStores.set(
        projection.projectionName,
        yield* platform.projection(projection, {
          name: projection.projectionName,
          options: { batch: Projection.batchMillis(implementation.options) },
          run: (key, batch) =>
            Effect.gen(function* () {
              // Platforms run handlers inside their runtime (a Durable Object, or this process).
              // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the platform runs handlers inside its runtime, which provides RuntimeContext
              yield* implementation.handle(
                kernel.projectionInputs(projection, key, batch),
              ) as Effect.Effect<void>;
              // What this run handled, so stream reads `atLeast` a receipt see it.
              if (writes.length === 0) return;
              const checkpoints: Record<string, number> = {};
              for (const { delivery } of batch) {
                checkpoints[delivery.source] = Math.max(
                  checkpoints[delivery.source] ?? 0,
                  delivery.seq,
                );
              }
              yield* Effect.forEach(writes, (store) => store.advance(key, checkpoints), {
                discard: true,
              });
            }).pipe(observeProjection(projection.projectionName, key, batch)),
        }),
      );
    }
    for (const policy of definitions.policies) {
      const handler = Context.getUnsafe(
        implementations as Context.Context<unknown>,
        policy as Context.Key<unknown, Policy.Handler<unknown>>,
      );
      policyStores.set(
        policy.policyName,
        yield* platform.policy(policy, kernel.policyKit(policy, handler)),
      );
    }

    // Queries run where the Api runs, reading your store and the model's members.
    const queryHosts = new Map<string, Query.Host>();
    for (const query of queries) {
      if (queryHosts.has(query.queryName)) {
        return yield* Effect.die(
          new Kernel.DefinitionError(`Duplicate query '${query.queryName}'`),
        );
      }
      for (const projection of query.definition.from ?? []) {
        if (!definitions.projections.includes(projection)) {
          return yield* Effect.die(
            new Kernel.DefinitionError(
              `${query.queryName} reads from ${projection.projectionName}, which is not in the Domain`,
            ),
          );
        }
      }
      const implementation = Context.getUnsafe(
        implementations as Context.Context<unknown>,
        query as Context.Key<unknown, Query.Implementation>,
      );
      queryHosts.set(
        query.queryName,
        Query.host(query, implementation, hosts, (projection) =>
          Context.getUnsafe(
            hosts,
            projection.Progress as Context.Key<unknown, Projection.Progress>,
          ),
        ),
      );
    }

    return Context.add(hosts, Internals, {
      kernel,
      aggregates: aggregateStores,
      views: viewStores,
      streams: streamStores,
      commands,
      viewHosts,
      streamHosts,
      queries: queryHosts,
    });
  });

const aggregateClient = (
  kernel: Kernel.Kernel,
  aggregate: Aggregate.Any,
  store: AggregateStore,
): Aggregate.ClientImpl => {
  /** What a send carries besides the command: its id, context, flow and trace. */
  const metaFor = (
    target: unknown,
    command: { readonly _tag: string },
    options: Aggregate.SendOptions | undefined,
    link: boolean,
  ) =>
    Effect.gen(function* () {
      const commandId = yield* Aggregate.commandIdFor(options);
      const context = yield* RequestContext.capture;
      const correlationId = yield* Telemetry.correlationFor(commandId);
      yield* Effect.annotateCurrentSpan({
        "domain.command_id": commandId,
        "domain.correlation_id": correlationId,
        ...Telemetry.attributesOf(command.constructor, command),
      });
      const trace = yield* Telemetry.currentTrace;
      return {
        id: Aggregate.targetId(target),
        meta: {
          commandId,
          context,
          correlationId,
          ...(trace ? { trace } : {}),
          ...(link ? { link } : {}),
        },
      };
    });
  const spanOptions = (target: unknown) => ({
    kind: "client" as const,
    attributes: {
      "domain.aggregate": aggregate.aggregateName,
      "domain.id": Aggregate.targetId(target),
    },
  });
  return {
    send: (target, command, options) =>
      Effect.gen(function* () {
        // The span records a rejection as an outcome; the caller still fails with it.
        const result = yield* Effect.gen(function* () {
          const { id, meta } = yield* metaFor(target, command, options, false);
          const result = yield* store.send(id, kernel.encodeCommand(aggregate, command), meta);
          yield* Effect.annotateCurrentSpan(
            "domain.outcome",
            result._tag === "Accepted"
              ? "accepted"
              : ((result.rejection as { readonly _tag?: string })._tag ?? "rejected"),
          );
          return result;
        }).pipe(
          Effect.withSpan(
            `Domain.send ${aggregate.aggregateName}.${command._tag}`,
            spanOptions(target),
          ),
        );
        return result._tag === "Rejected"
          ? yield* Effect.fail(kernel.decodeRejection(aggregate, result.rejection))
          : kernel.decodeReceipt(aggregate, command._tag, result.receipt);
      }),
    schedule: (target, command, options) =>
      Effect.gen(function* () {
        // The command runs later, so its span links back here rather than continuing this trace.
        const { id, meta } = yield* metaFor(target, command, options, true);
        const at = yield* store.schedule(
          id,
          kernel.encodeCommand(aggregate, command),
          meta,
          options.at !== undefined
            ? { at: DateTime.toEpochMillis(options.at) }
            : { afterMillis: Duration.toMillis(Duration.fromInputUnsafe(options.after)) },
        );
        return { commandId: meta.commandId, at: DateTime.makeUnsafe(at) };
      }).pipe(
        Effect.withSpan(
          `Domain.schedule ${aggregate.aggregateName}.${command._tag}`,
          spanOptions(target),
        ),
      ),
    unschedule: (target, commandId) =>
      store.unschedule(Aggregate.targetId(target), commandId).pipe(
        Effect.withSpan(`Domain.unschedule ${aggregate.aggregateName}`, {
          ...spanOptions(target),
          attributes: { ...spanOptions(target).attributes, "domain.command_id": commandId },
        }),
      ),
    state: (target) =>
      store
        .state(Aggregate.targetId(target))
        .pipe(Effect.map(({ state }) => kernel.decodeState(aggregate, state))),
  };
};

const decodeSnapshot = (
  kernel: Kernel.Kernel,
  view: View.Any,
  snapshot: ViewSnapshot,
): Option.Option<unknown> =>
  snapshot.state === null
    ? Option.none()
    : Option.some(kernel.decodeViewState(view, snapshot.state));

const viewHost = (
  kernel: Kernel.Kernel,
  view: View.Any,
  store: ViewStore,
): View.Host<unknown, Key.Any, unknown> => {
  const watch = (key: Key.RefOf<Key.Any>, options?: View.WatchOptions<unknown>) =>
    store.changes(Aggregate.targetId(key)).pipe(
      Stream.map((snapshot) =>
        Option.filter(decodeSnapshot(kernel, view, snapshot), (state) =>
          matches(options?.where, state),
        ),
      ),
      Stream.changesWith((a, b) =>
        Option.isNone(a) && Option.isNone(b)
          ? true
          : Option.isSome(a) && Option.isSome(b) && a.value === b.value,
      ),
    );
  const watchEach = <P, E, R>(
    parent: Stream.Stream<P, E, R>,
    keysOf: (parent: P) => ReadonlyArray<Key.RefOf<Key.Any>>,
    options?: View.WatchOptions<unknown>,
  ): Stream.Stream<readonly [P, ReadonlyArray<readonly [Key.RefOf<Key.Any>, unknown]>], E, R> =>
    parent.pipe(
      Stream.switchMap(
        (p): Stream.Stream<readonly [P, ReadonlyArray<readonly [Key.RefOf<Key.Any>, unknown]>]> => {
          const keys = keysOf(p);
          if (keys.length === 0) return Stream.succeed([p, []]);
          return Stream.zipLatestAll(
            ...keys.map((key) => watch(key, options).pipe(Stream.map((o) => [key, o] as const))),
          ).pipe(
            Stream.map(
              (pairs) =>
                [
                  p,
                  pairs.flatMap(([key, state]) =>
                    Option.isSome(state) ? [[key, state.value] as const] : [],
                  ),
                ] as const,
            ),
          );
        },
      ),
    );
  /** The stored snapshot of a key, once it has applied `atLeast` (if given). */
  const readAtLeast = (
    id: string,
    options?: {
      readonly atLeast?: { readonly stream: string; readonly version: number };
      readonly timeout?: Duration.Input;
    },
  ) => {
    const read = store.read(id);
    const atLeast = options?.atLeast;
    if (!atLeast) return read;
    return read.pipe(
      Effect.flatMap((snapshot) =>
        (snapshot.checkpoints[atLeast.stream] ?? 0) >= atLeast.version
          ? Effect.succeed(snapshot)
          : Effect.fail("stale" as const),
      ),
      Effect.retry({
        schedule: Schedule.spaced("25 millis"),
        times: Math.ceil(
          Duration.toMillis(Duration.fromInputUnsafe(options?.timeout ?? "10 seconds")) / 25,
        ),
      }),
      Effect.mapError(() =>
        View.ConsistencyTimeout.make({
          view: view.viewName,
          key: id,
          stream: atLeast.stream,
          version: atLeast.version,
        }),
      ),
    );
  };
  return {
    query: (key, options) =>
      readAtLeast(Aggregate.targetId(key), options).pipe(
        Effect.map((snapshot) => decodeSnapshot(kernel, view, snapshot)),
      ),
    // State and seq come from one stored snapshot, so the cursor matches the state.
    snapshot: (key, options) =>
      readAtLeast(Aggregate.targetId(key), options).pipe(
        Effect.map((snapshot) => ({
          state: Option.getOrNull(decodeSnapshot(kernel, view, snapshot)),
          cursor: snapshot.seq,
        })),
      ),
    waitFor: (key, where, options) =>
      watch(key, { where }).pipe(
        Stream.filter(Option.isSome),
        Stream.map((state) => state.value),
        Stream.runHead,
        Effect.timeoutOption(options.timeout),
        Effect.flatMap((result) =>
          Option.isSome(result) && Option.isSome(result.value)
            ? Effect.succeed(result.value.value)
            : Effect.fail(
                new View.WaitTimeout({ view: view.viewName, key: Aggregate.targetId(key) }),
              ),
        ),
      ),
    watch,
    watchEach,
    events: (key, options) =>
      store.tail(Aggregate.targetId(key), options?.after ?? 0).pipe(
        Stream.map((entry) => kernel.decodeViewEntry(view, entry)),
        Stream.filter((entry) => matches(options?.where, entry.event)),
      ),
    list: (key, options) =>
      store.list(Aggregate.targetId(key)).pipe(
        Effect.map((stored) => {
          const desc = options?.order === "desc";
          const after = options?.after;
          const rows = (desc ? [...stored].reverse() : stored)
            .filter((row) => after === undefined || (desc ? row.seq < after : row.seq > after))
            .map((row) => ({ seq: row.seq, entry: kernel.decodeViewEntry(view, row) }))
            .filter((row) => matches(options?.where, row.entry.event));
          const take = options?.take ?? rows.length;
          const page = rows.slice(0, take);
          return {
            entries: page.map((row) => row.entry),
            cursor: rows.length > take && page.length > 0 ? page[page.length - 1]!.seq : null,
          };
        }),
      ),
  };
};

/** Wait until a progress check passes, retrying every 25ms up to `timeout`. */
const waitUntil = <A>(
  check: Effect.Effect<A, "stale">,
  timeout: Duration.Input | undefined,
  onTimeout: () => View.ConsistencyTimeout,
) =>
  check.pipe(
    Effect.retry({
      schedule: Schedule.spaced("25 millis"),
      times: Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(timeout ?? "10 seconds")) / 25),
    }),
    Effect.mapError(onTimeout),
  );

const streamHost = (
  kernel: Kernel.Kernel,
  stream: DomainStream.Any,
  store: StreamStore,
): DomainStream.Host<Key.Any, unknown> => {
  const decode = (entry: StreamEntry) => kernel.decodeStreamEntry(entry);
  const latest = (key: string, meta: StreamMeta) =>
    meta.seq === 0
      ? Effect.succeedNone
      : store
          .tail(key, meta.seq - 1)
          .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.map(decode)));
  return {
    peek: (key, options) => {
      const atLeast = options?.atLeast;
      const read = atLeast
        ? waitUntil(
            store
              .read(Aggregate.targetId(key))
              .pipe(
                Effect.flatMap((meta) =>
                  (meta.checkpoints[atLeast.stream] ?? 0) >= atLeast.version
                    ? Effect.succeed(meta)
                    : Effect.fail("stale" as const),
                ),
              ),
            options?.timeout,
            () =>
              View.ConsistencyTimeout.make({
                view: stream.streamName,
                key: Aggregate.targetId(key),
                stream: atLeast.stream,
                version: atLeast.version,
              }),
          )
        : store.read(Aggregate.targetId(key));
      return read.pipe(Effect.flatMap((meta) => latest(Aggregate.targetId(key), meta)));
    },
    watch: (key) =>
      store.changes(Aggregate.targetId(key)).pipe(
        Stream.changesWith((a, b) => a.seq === b.seq),
        Stream.mapEffect((meta) => latest(Aggregate.targetId(key), meta)),
      ),
    events: (key, options) =>
      store.tail(Aggregate.targetId(key), options?.after ?? 0).pipe(
        Stream.map(decode),
        Stream.filter((entry) => matches(options?.where, entry.event)),
      ),
    list: (key, options) =>
      store.list(Aggregate.targetId(key)).pipe(
        Effect.map((stored) => {
          const desc = options?.order === "desc";
          const after = options?.after;
          const rows = (desc ? [...stored].reverse() : stored)
            .filter((row) => after === undefined || (desc ? row.seq < after : row.seq > after))
            .map((row) => ({ seq: row.seq, entry: decode(row) }))
            .filter((row) => matches(options?.where, row.entry.event));
          const take = options?.take ?? rows.length;
          const page = rows.slice(0, take);
          return {
            entries: page.map((row) => row.entry),
            cursor: rows.length > take && page.length > 0 ? page[page.length - 1]!.seq : null,
          };
        }),
      ),
    append: (origin, ...events) =>
      Effect.suspend(() => {
        const meta = (origin as unknown as Record<symbol, Kernel.InputMetaValue | undefined>)[
          Kernel.InputMeta
        ];
        const writer = kernel.writerOf(stream);
        if (!meta || !writer || writer.projectionName !== meta.projection) {
          return Effect.die(
            new Kernel.DefinitionError(
              `Only the projection that lists ${stream.streamName} in \`writes\` may append to it, with the input it is handling`,
            ),
          );
        }
        meta.appends += 1;
        return store.append(meta.key, {
          origin: [meta.position, meta.appends],
          source: meta.source,
          sourceSeq: meta.sourceSeq,
          at: meta.at,
          commandId: meta.commandId,
          events: events.map((event) => kernel.encodeEvent(event as { readonly _tag: string })),
        });
      }),
  };
};

/**
 * The events of the command that brought an aggregate instance to `version`:
 * the run of events up to it that share its last event's command id. Reads a
 * small window first, and widens it only for a command with many events.
 */
const commandEvents = (
  store: AggregateStore,
  id: string,
  version: number,
): Effect.Effect<ReadonlyArray<StoredEvent>> =>
  Effect.gen(function* () {
    // A version beyond the instance's is clamped: there is nothing more to wait for.
    const last = Math.min(version, (yield* store.state(id)).version);
    if (last <= 0) return [];
    for (let window = 8; ; window *= 4) {
      const from = Math.max(0, last - window);
      const events = yield* store.tail(id, from).pipe(
        Stream.takeUntil((stored) => stored.envelope.seq >= last),
        Stream.runCollect,
      );
      const commandId = events[events.length - 1]?.envelope.commandId;
      let start = events.length - 1;
      while (start > 0 && events[start - 1]!.envelope.commandId === commandId) start--;
      if (start > 0 || from === 0) return events.slice(Math.max(0, start));
    }
  });

const projectionProgress = (
  kernel: Kernel.Kernel,
  projection: Projection.Any,
  store: () => ProjectionStore,
  aggregates: ReadonlyMap<string, AggregateStore>,
): Projection.Progress => ({
  caughtUp: (receipt, options) =>
    Effect.gen(function* () {
      const [aggregate, ...rest] = receipt.stream.split("/");
      const id = rest.join("/");
      // A receipt from a client carries no events: read them from the aggregate.
      const consumes = projection.definition.from.some(
        (source) => source.kind === "Aggregate" && source.aggregateName === aggregate,
      );
      const source = aggregates.get(aggregate!);
      const events: ReadonlyArray<{ readonly event: unknown; readonly seq: number }> =
        receipt.events !== undefined
          ? receipt.events.map((event, index) => ({
              event,
              seq: receipt.version - receipt.events!.length + 1 + index,
            }))
          : consumes && source
            ? (yield* commandEvents(source, id, receipt.version)).map((stored) => ({
                event: kernel.decodeEvent(stored.event),
                seq: stored.envelope.seq,
              }))
            : [];
      const waits = new Map<string, number>();
      for (const { event, seq } of events) {
        for (const key of kernel.projectionKeys(
          projection,
          aggregate!,
          id,
          event as { readonly _tag: string },
          seq,
        )) {
          waits.set(key, Math.max(waits.get(key) ?? 0, seq));
        }
      }
      yield* Effect.forEach(
        waits,
        ([key, seq]) =>
          waitUntil(
            store()
              .checkpoints(key)
              .pipe(
                Effect.flatMap((checkpoints) =>
                  (checkpoints[receipt.stream] ?? 0) >= seq
                    ? Effect.void
                    : Effect.fail("stale" as const),
                ),
              ),
            options?.timeout,
            () =>
              View.ConsistencyTimeout.make({
                view: projection.projectionName,
                key,
                stream: receipt.stream,
                version: seq,
              }),
          ),
        { discard: true },
      );
    }),
});
