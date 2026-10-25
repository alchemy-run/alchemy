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
import * as Command from "./Command.ts";
import { matches } from "./Filter.ts";
import * as Kernel from "./Kernel.ts";
import {
  type Accepted,
  type AggregateStore,
  type Delivery,
  Platform,
  type PolicyStore,
  type ProjectionStore,
  type StreamEntry,
  type StreamMeta,
  type StreamStore,
  type ViewSnapshot,
  type ViewStore,
} from "./Platform.ts";
import type * as Policy from "./Policy.ts";
import * as Projection from "./Projection.ts";
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
    readonly viewHosts: ReadonlyMap<string, View.Host<unknown, View.KeySource, unknown>>;
    /** Each stream's API, by stream name. */
    readonly streamHosts: ReadonlyMap<string, DomainStream.Host<Aggregate.Any, unknown>>;
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
> {
  readonly aggregates: A;
  readonly views?: V;
  readonly policies?: P;
  readonly projections?: J;
  readonly streams?: S;
  readonly sagas?: G;
}

/**
 * The class type returned by {@link make}.
 *
 * `Provided` is every aggregate, view, stream and projection-progress service
 * the Model provides; `Policies` is every policy and projection whose
 * implementation `layer` requires.
 */
export interface ModelClass<Name extends string, Provided, Policies> {
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
  ): Layer.Layer<Provided | Internals, E, Platform | Exclude<R, Provided>>;
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

/** Every implementation a model's `layer` requires: its policies, projections and sagas. */
type HandledBy<
  P extends ReadonlyArray<Policy.Any>,
  J extends ReadonlyArray<Projection.Any>,
  G extends ReadonlyArray<Saga.Any>,
> = Identifier<P[number]> | Identifier<J[number]> | Saga.ImplementationIdentifier<G[number]>;

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
>(
  name: Name,
  members: Members<A, V, P, J, S, G>,
): ModelClass<Name, ProvidedBy<A, V, J, S, G>, HandledBy<P, J, G>> => {
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
    static layer<E, R>(handlers: Layer.Layer<HandledBy<P, J, G>, E, R>, options?: LayerOptions) {
      return Layer.effectContext(
        build(definitions, handlers, members.sagas ?? [], Telemetry.resolve(options?.telemetry)),
      );
    }
  } as unknown as ModelClass<Name, ProvidedBy<A, V, J, S, G>, HandledBy<P, J, G>>;
};

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
  telemetry: Telemetry.Resolved,
) =>
  Effect.gen(function* () {
    const platform = yield* Platform;
    const kernel = Kernel.make(definitions, telemetry);

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
    const viewHosts = new Map<string, View.Host<unknown, View.KeySource, unknown>>();
    for (const view of definitions.views) {
      const host = viewHost(kernel, view, viewStores.get(view.viewName)!);
      viewHosts.set(view.viewName, host);
      hosts = Context.add(hosts, view, host);
    }
    const streamHosts = new Map<string, DomainStream.Host<Aggregate.Any, unknown>>();
    for (const stream of definitions.streams) {
      const host = streamHost(kernel, stream, streamStores.get(stream.streamName)!);
      streamHosts.set(stream.streamName, host);
      hosts = Context.add(hosts, stream, host);
    }
    for (const projection of definitions.projections) {
      hosts = Context.add(
        hosts,
        projection.Progress,
        projectionProgress(kernel, projection, () =>
          projectionStores.get(projection.projectionName)!,
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

    return Context.add(hosts, Internals, {
      kernel,
      aggregates: aggregateStores,
      views: viewStores,
      streams: streamStores,
      commands,
      viewHosts,
      streamHosts,
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
        yield* store.schedule(
          id,
          kernel.encodeCommand(aggregate, command),
          meta,
          options.at !== undefined
            ? { at: DateTime.toEpochMillis(options.at) }
            : { afterMillis: Duration.toMillis(Duration.fromInputUnsafe(options.after)) },
        );
      }).pipe(
        Effect.withSpan(
          `Domain.schedule ${aggregate.aggregateName}.${command._tag}`,
          spanOptions(target),
        ),
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
): View.Host<unknown, View.KeySource, unknown> => {
  const watch = (key: View.RefOf<View.KeySource>, options?: View.WatchOptions<unknown>) =>
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
    keysOf: (parent: P) => ReadonlyArray<View.RefOf<View.KeySource>>,
    options?: View.WatchOptions<unknown>,
  ): Stream.Stream<
    readonly [P, ReadonlyArray<readonly [View.RefOf<View.KeySource>, unknown]>],
    E,
    R
  > =>
    parent.pipe(
      Stream.switchMap(
        (
          p,
        ): Stream.Stream<
          readonly [P, ReadonlyArray<readonly [View.RefOf<View.KeySource>, unknown]>]
        > => {
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
  return {
    query: (key, options) => {
      const read = store.read(Aggregate.targetId(key));
      const atLeast = options?.atLeast;
      if (!atLeast)
        return read.pipe(Effect.map((snapshot) => decodeSnapshot(kernel, view, snapshot)));
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
        Effect.map((snapshot) => decodeSnapshot(kernel, view, snapshot)),
        Effect.mapError(
          () =>
            new View.ConsistencyTimeout({
              view: view.viewName,
              key: Aggregate.targetId(key),
              stream: atLeast.stream,
              version: atLeast.version,
            }),
        ),
      );
    },
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
      store.tail(Aggregate.targetId(key), options?.after ? Number(options.after) : 0).pipe(
        Stream.map((entry) => kernel.decodeViewEntry(view, entry)),
        Stream.filter((entry) => matches(options?.where, entry.event)),
      ),
    list: (key, options) =>
      store.list(Aggregate.targetId(key)).pipe(
        Effect.map((stored) => {
          const desc = options?.order === "desc";
          const after = options?.after === undefined ? undefined : Number(options.after);
          const rows = (desc ? [...stored].reverse() : stored)
            .filter((row) => after === undefined || (desc ? row.seq < after : row.seq > after))
            .map((row) => ({ seq: row.seq, entry: kernel.decodeViewEntry(view, row) }))
            .filter((row) => matches(options?.where, row.entry.event));
          const take = options?.take ?? rows.length;
          const page = rows.slice(0, take);
          return {
            entries: page.map((row) => row.entry),
            cursor:
              rows.length > take && page.length > 0 ? String(page[page.length - 1]!.seq) : null,
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
): DomainStream.Host<Aggregate.Any, unknown> => {
  const decode = (entry: StreamEntry) => kernel.decodeStreamEntry(entry);
  const latest = (key: string, meta: StreamMeta) =>
    meta.seq === 0
      ? Effect.succeed(Option.none())
      : store
          .tail(key, meta.seq - 1)
          .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.map(decode)));
  return {
    peek: (key, options) => {
      const atLeast = options?.atLeast;
      const read = atLeast
        ? waitUntil(
            store
              .read(key.id)
              .pipe(
                Effect.flatMap((meta) =>
                  (meta.checkpoints[atLeast.stream] ?? 0) >= atLeast.version
                    ? Effect.succeed(meta)
                    : Effect.fail("stale" as const),
                ),
              ),
            options?.timeout,
            () =>
              new View.ConsistencyTimeout({
                view: stream.streamName,
                key: key.id,
                stream: atLeast.stream,
                version: atLeast.version,
              }),
          )
        : store.read(key.id);
      return read.pipe(Effect.flatMap((meta) => latest(key.id, meta)));
    },
    watch: (key) =>
      store.changes(key.id).pipe(
        Stream.changesWith((a, b) => a.seq === b.seq),
        Stream.mapEffect((meta) => latest(key.id, meta)),
      ),
    events: (key, options) =>
      store.tail(key.id, options?.after ?? 0).pipe(
        Stream.map(decode),
        Stream.filter((entry) => matches(options?.where, entry.event)),
      ),
    list: (key, options) =>
      store.list(key.id).pipe(
        Effect.map((stored) => {
          const desc = options?.order === "desc";
          const after = options?.after === undefined ? undefined : Number(options.after);
          const rows = (desc ? [...stored].reverse() : stored)
            .filter((row) => after === undefined || (desc ? row.seq < after : row.seq > after))
            .map((row) => ({ seq: row.seq, entry: decode(row) }))
            .filter((row) => matches(options?.where, row.entry.event));
          const take = options?.take ?? rows.length;
          const page = rows.slice(0, take);
          return {
            entries: page.map((row) => row.entry),
            cursor:
              rows.length > take && page.length > 0 ? String(page[page.length - 1]!.seq) : null,
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

const projectionProgress = (
  kernel: Kernel.Kernel,
  projection: Projection.Any,
  store: () => ProjectionStore,
): Projection.Progress => ({
  caughtUp: (receipt, options) =>
    Effect.gen(function* () {
      const [aggregate, ...rest] = receipt.stream.split("/");
      const id = rest.join("/");
      const first = receipt.version - receipt.events.length + 1;
      const waits = new Map<string, number>();
      receipt.events.forEach((event, index) => {
        for (const key of kernel.projectionKeys(
          projection,
          aggregate!,
          id,
          event as { readonly _tag: string },
          first + index,
        )) {
          waits.set(key, Math.max(waits.get(key) ?? 0, first + index));
        }
      });
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
              new View.ConsistencyTimeout({
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
