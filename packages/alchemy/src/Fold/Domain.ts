import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Aggregate from "./Aggregate.ts";
import { matches } from "./Filter.ts";
import * as Kernel from "./Kernel.ts";
import {
  type AggregateStore,
  type Delivery,
  FoldPlatform,
  type PolicyStore,
  type ViewSnapshot,
  type ViewStore,
} from "./Platform.ts";
import type * as Policy from "./Policy.ts";
import * as View from "./View.ts";

type Identifier<T> = T extends Context.Key<infer I, unknown> ? I : never;

/**
 * Low-level access to a built Domain's kernel and stores (story runner,
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
  }
>()("alchemy/Fold/DomainInternals") {}

/**
 * The entities that make up a Domain.
 */
export interface Members<
  A extends ReadonlyArray<Aggregate.Any>,
  V extends ReadonlyArray<View.Any>,
  P extends ReadonlyArray<Policy.Any>,
> {
  readonly aggregates: A;
  readonly views?: V;
  readonly policies?: P;
}

/**
 * The class type returned by {@link make}.
 *
 * `Provided` is every aggregate and view service the Domain provides;
 * `Policies` is every policy whose implementation `layer` requires.
 */
export interface DomainClass<Name extends string, Provided, Policies> {
  new (_: never): {};
  readonly kind: "Domain";
  readonly domainName: Name;
  readonly definitions: Kernel.Definitions;
  /**
   * Host every entity on the ambient {@link FoldPlatform}. The policy Layers
   * are built after the aggregates and views exist, so a policy can
   * resolve their clients while it is constructed.
   */
  layer<E = never, R = never>(
    policies: Layer.Layer<Policies, E, R>,
  ): Layer.Layer<Provided | Internals, E, FoldPlatform | Exclude<R, Provided>>;
}

/**
 * Structural constraint satisfied by every domain class.
 */
export interface Any {
  readonly kind: "Domain";
  readonly domainName: string;
  readonly definitions: Kernel.Definitions;
}

/**
 * Declare a Domain: the complete set of aggregates, views and policies hosted
 * together.
 *
 * `MyDomain.layer(policies)` builds every entity on the ambient
 * {@link FoldPlatform} and provides each aggregate and view as a
 * service. The policies' Layers are part of the call because they are built
 * with those services available.
 *
 * **Example:** Declaring and hosting a domain
 * ```typescript
 * export class Bank extends Domain.make("Bank", {
 *   aggregates: [Customer, Account, Transfer],
 *   views: [AccountSummary, TransferStatus, Statement],
 *   policies: [TransferExecution, FraudReview],
 * }) {}
 *
 * const BankLive = Bank.layer(Layer.mergeAll(TransferExecutionLive, FraudReviewLive)).pipe(
 *   Layer.provide(Layer.mergeAll(Fold.InMemory, SiftFraudCheck)),
 * );
 * ```
 */
export const make = <
  const Name extends string,
  const A extends ReadonlyArray<Aggregate.Any>,
  const V extends ReadonlyArray<View.Any> = readonly [],
  const P extends ReadonlyArray<Policy.Any> = readonly [],
>(
  name: Name,
  members: Members<A, V, P>,
): DomainClass<Name, Identifier<A[number]> | Identifier<V[number]>, Identifier<P[number]>> => {
  const definitions: Kernel.Definitions = {
    aggregates: members.aggregates,
    views: members.views ?? [],
    policies: members.policies ?? [],
  };
  return class {
    static readonly kind = "Domain" as const;
    static readonly domainName: Name = name;
    static readonly definitions: Kernel.Definitions = definitions;
    static layer<E, R>(policies: Layer.Layer<Identifier<P[number]>, E, R>) {
      return Layer.effectContext(build(definitions, policies));
    }
  } as unknown as DomainClass<
    Name,
    Identifier<A[number]> | Identifier<V[number]>,
    Identifier<P[number]>
  >;
};

const build = <A, E, R>(definitions: Kernel.Definitions, policies: Layer.Layer<A, E, R>) =>
  Effect.gen(function* () {
    const platform = yield* FoldPlatform;
    const kernel = Kernel.make(definitions);

    const aggregateStores = new Map<string, AggregateStore>();
    const viewStores = new Map<string, ViewStore>();
    const policyStores = new Map<string, PolicyStore>();

    const deliver = (delivery: Delivery): Effect.Effect<void> =>
      Effect.suspend(() => {
        const { kind, name } = delivery.target;
        if (kind === "view") return viewStores.get(name)!.receive(delivery.key, [delivery]);
        const store = policyStores.get(name);
        return store
          ? store.receive(delivery)
          : Effect.die(new Error(`Policy ${name} is not hosted yet`));
      });

    for (const aggregate of definitions.aggregates) {
      aggregateStores.set(
        aggregate.aggregateName,
        yield* platform.aggregate(aggregate, kernel.aggregateKit(aggregate, deliver)),
      );
    }
    for (const view of definitions.views) {
      viewStores.set(view.viewName, yield* platform.view(view, kernel.viewKit(view, deliver)));
    }

    let hosts = Context.empty() as Context.Context<unknown>;
    for (const aggregate of definitions.aggregates) {
      hosts = Context.add(
        hosts,
        aggregate,
        aggregateClient(kernel, aggregate, aggregateStores.get(aggregate.aggregateName)!),
      );
    }
    for (const view of definitions.views) {
      hosts = Context.add(hosts, view, viewHost(kernel, view, viewStores.get(view.viewName)!));
    }

    // Policies are built with the clients available, then hosted.
    const implementations = yield* Layer.build(policies).pipe(Effect.provide(hosts));
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
    });
  });

const aggregateClient = (
  kernel: Kernel.Kernel,
  aggregate: Aggregate.Any,
  store: AggregateStore,
): Aggregate.ClientImpl => ({
  send: (target, command, options) =>
    Effect.gen(function* () {
      const commandId = yield* Aggregate.commandIdFor(options);
      const result = yield* store.send(
        Aggregate.targetId(target),
        kernel.encodeCommand(aggregate, command),
        { commandId },
      );
      return result._tag === "Rejected"
        ? yield* Effect.fail(kernel.decodeRejection(aggregate, result.rejection))
        : kernel.decodeReceipt(aggregate, command._tag, result.receipt);
    }),
  state: (target) =>
    store
      .state(Aggregate.targetId(target))
      .pipe(Effect.map(({ state }) => kernel.decodeState(aggregate, state))),
});

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
): View.Host<unknown, Aggregate.Any, unknown> => {
  const watch = (key: Aggregate.Ref, options?: View.WatchOptions<unknown>) =>
    store.changes(key.id).pipe(
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
    keysOf: (parent: P) => ReadonlyArray<Aggregate.Ref>,
    options?: View.WatchOptions<unknown>,
  ): Stream.Stream<readonly [P, ReadonlyArray<readonly [Aggregate.Ref, unknown]>], E, R> =>
    parent.pipe(
      Stream.switchMap(
        (p): Stream.Stream<readonly [P, ReadonlyArray<readonly [Aggregate.Ref, unknown]>]> => {
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
      const read = store.read(key.id);
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
              key: key.id,
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
            : Effect.fail(new View.WaitTimeout({ view: view.viewName, key: key.id })),
        ),
      ),
    watch,
    watchEach,
    events: (key, options) =>
      store.tail(key.id, options?.after ? Number(options.after) : 0).pipe(
        Stream.map((entry) => kernel.decodeViewEntry(view, entry)),
        Stream.filter((entry) => matches(options?.where, entry.event)),
      ),
    list: (key, options) =>
      store.list(key.id).pipe(
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
