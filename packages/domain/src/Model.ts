import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import type { Annotations } from "./Annotations.ts";
import * as CatchUp from "./CatchUp.ts";
import type * as Command from "./Command.ts";
import type * as Decision from "./Decision.ts";
import {
  DecisionsUnsupported,
  DefinitionError,
  UnhandledCommand,
  ForeignAppend,
  LazyViewNeedsOneSource,
  MissingWorkflowEngine,
  UnvalidatedRead,
} from "./DefinitionError.ts";
import { type Filter, matches } from "./Filter.ts";
import * as Kernel from "./Kernel.ts";
import * as Key from "./Key.ts";
import {
  type Accepted,
  type AggregateStore,
  type DecisionStore,
  type Delivery,
  type EmittedRange,
  type Json,
  type ListRange,
  type ModelHost,
  Platform,
  type PolicyStore,
  type ProjectionStore,
  type StoredEvent,
  type StreamEntry,
  type StreamMeta,
  type StreamStore,
  type ViewEntry,
  type ViewSnapshot,
  type ViewStore,
  runDirectly,
  RunWait,
} from "./Platform.ts";
import type * as Policy from "./Policy.ts";
import * as Projection from "./Projection.ts";
import * as Query from "./Query.ts";
import * as Read from "./Read.ts";
import type * as Relation from "./Relation.ts";
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
    /**
     * The client of what implements each command, by command tag: its
     * aggregate, or its decision as an aggregate client that takes no target.
     */
    readonly commands: ReadonlyMap<string, Aggregate.ClientImpl>;
    /** Each view's read API, by view name. */
    readonly viewHosts: ReadonlyMap<string, View.Host<unknown, Key.Any, unknown>>;
    /** Each stream's API, by stream name. */
    readonly streamHosts: ReadonlyMap<string, DomainStream.Host<Key.Any, unknown>>;
    /** Each query, hosted, by query name. */
    readonly queries: ReadonlyMap<string, Query.Host>;
    /** Each guarded view's and stream's `validate`, from its Layer, by name. */
    readonly validators: ReadonlyMap<string, Read.AnyValidate>;
    /**
     * Wait until a view or stream, by name, has applied a command's events on
     * the keys they reach: every one, or `key` alone for a view. A command
     * none of whose events reach it is not waited for.
     */
    readonly caughtUp: ReadonlyMap<string, Query.CaughtUp>;
    /**
     * Wait until every view a command's events reach has applied them, on
     * every key, through any views between. A view whose history has not all
     * reached it yet (one a deploy is still backfilling) is not waited for.
     *
     * "Applied" is what the view key's stored checkpoints say, so the
     * guarantee is only as strong as the platform's: see
     * `ViewSnapshot.checkpoints` for what a platform with read replicas owes.
     */
    readonly applied: (
      receipt: Aggregate.Receipt,
      options?: { readonly timeout?: Duration.Input },
    ) => Effect.Effect<void, View.ConsistencyTimeout>;
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
  D extends ReadonlyArray<Decision.Any> = readonly [],
> {
  readonly aggregates: A;
  /**
   * The decisions that implement commands across several aggregates. Each
   * command has one implementation: listing a decision for a command an
   * aggregate or another decision implements is a type error on its entry.
   */
  readonly decisions?: ImplementedOnce<A, D>;
  readonly views?: V;
  readonly policies?: P;
  readonly projections?: J;
  readonly streams?: S;
  readonly sagas?: G;
  /** The queries it answers, from the stores its projections write. */
  readonly queries?: Q;
  /**
   * Rules that hold across the model's aggregates whenever nothing is left to
   * react: every policy has handled the events it reacts to and every saga
   * has finished or waits. Each is named and given every instance, with its
   * state and the events it recorded, every key of the model's views with
   * its state, and what each projection was given: `true` while the rule holds. `Explore.check` looks for a
   * sequence of commands that breaks one.
   */
  readonly invariants?: {
    readonly [name: string]: (model: Instances<A> & Keys<V> & Fed<J>) => boolean;
  };
  /**
   * Rules that relate a few instances at all times, each made with
   * `Domain.Relation`. `Verify.model` proves one where every command and
   * every decision that records on its aggregates keeps it, and looks for a
   * sequence of commands that breaks one it cannot prove.
   */
  readonly relations?: { readonly [name: string]: Relation.Any };
  /**
   * Rules that hold once everything has run its course: nothing is left to
   * react, and every scheduled command has come due and run. Where an
   * invariant says what is never true along the way, one of these says where
   * every sequence ends up. Each is named and given what an invariant is.
   * `Explore.check` runs every sequence it finds to its end and looks for
   * one that ends without it.
   */
  readonly eventually?: {
    readonly [name: string]: (model: Instances<A> & Keys<V> & Fed<J>) => boolean;
  };
}

/**
 * What each of a model's projections has been given, by projection name,
 * oldest first: what a model invariant is given. A projection writes where
 * the model cannot see, so what it was told is what a rule can speak of.
 */
export type Fed<J extends ReadonlyArray<Projection.Any>> = {
  readonly [K in J[number] as K["projectionName"]]: ReadonlyArray<{
    /** The id of the key the event was given under. */
    readonly id: string;
    readonly event: Aggregate.InstanceOf<K["definition"]["on"][number]>;
  }>;
};

/** Every key of a model's views that has a state, by view name: what a model invariant is given. */
export type Keys<V extends ReadonlyArray<View.Any>> = {
  readonly [K in V[number] as K["viewName"]]: ReadonlyArray<{
    /** The id of the instance the key follows. */
    readonly id: string;
    readonly state: NonNullable<View.StateOf<K>>;
  }>;
};

/** Every instance of a model's aggregates, by aggregate name: what a model invariant is given. */
export type Instances<A extends ReadonlyArray<Aggregate.Any>> = {
  readonly [K in A[number] as K["aggregateName"]]: ReadonlyArray<{
    readonly id: Aggregate.IdOf<K>;
    readonly state: Aggregate.StateOf<K>;
    /** Every event the instance recorded, oldest first. */
    readonly events: ReadonlyArray<Aggregate.EventOf<K>>;
  }>;
};

/**
 * The class type returned by {@link make}.
 *
 * `Provided` is every aggregate, view, stream and projection-progress service
 * the Model provides; `Policies` is every policy, projection and query whose
 * implementation `layer` requires.
 */
export interface ModelClass<
  Name extends string,
  Provided,
  Policies,
  Parts extends Servable = Servable,
> {
  new (_: never): {};
  readonly kind: "Model";
  readonly annotations: Annotations;
  readonly modelName: Name;
  /** The model's aggregates, in order. */
  readonly aggregates: Parts["aggregates"];
  /** The model's decisions, in order. */
  readonly decisions: Parts["decisions"];
  /** Every command of the model's aggregates and decisions, each once. */
  readonly commands: Parts["commands"];
  /** The model's views, in order. */
  readonly views: Parts["views"];
  /** The model's streams, in order. */
  readonly streams: Parts["streams"];
  /** The model's queries, in order. */
  readonly queries: Parts["queries"];
  /** The model's own invariants, by name. */
  readonly invariants: { readonly [name: string]: (model: never) => boolean };
  /** What holds once everything has run its course, by name. */
  readonly eventually: { readonly [name: string]: (model: never) => boolean };
  /** The model's relations, by name. */
  readonly relations: { readonly [name: string]: Relation.Any };
  readonly definitions: Kernel.Definitions;
  /**
   * Host every entity on the ambient {@link Platform}. The policy and
   * projection Layers (`handlers`) are built after the aggregates, views and
   * streams exist, so a handler can resolve them while it is constructed.
   * `options` tune how it's hosted, such as what it records in traces.
   */
  layer<E = never, R = never>(
    handlers: Layer.Layer<Policies, E, R>,
    options?: LayerOptions<Parts["views"][number]["viewName"]>,
  ): Layer.Layer<
    Provided | Internals,
    E,
    Platform | SecureRandom.SecureRandom | Exclude<R, Provided>
  >;
}

/**
 * Structural constraint satisfied by every Model class.
 */
export interface Any extends Servable {
  readonly kind: "Model";
  readonly annotations: Annotations;
  readonly modelName: string;
  readonly definitions: Kernel.Definitions;
}

/**
 * What an Api over a model may serve, in the order the model lists them:
 * its aggregates, their commands, its views and its streams. An Api names
 * what it serves from these.
 */
export interface Servable {
  readonly aggregates: ReadonlyArray<Aggregate.Any>;
  readonly decisions: ReadonlyArray<Decision.Any>;
  /** Every command of the model's aggregates and decisions, each once. */
  readonly commands: ReadonlyArray<Command.Any>;
  readonly views: ReadonlyArray<View.Any>;
  readonly streams: ReadonlyArray<DomainStream.Any>;
  readonly queries: ReadonlyArray<Query.Any>;
}

/** The name of the aggregate, among `A`, that implements the command tagged `Tag`. */
type ImplementerOf<A extends ReadonlyArray<Aggregate.Any>, Tag> = A[number] extends infer Agg
  ? Agg extends Aggregate.Any
    ? // A widened aggregate (another model's `aggregates`) names no command: checked when the model is built.
      string extends Agg["definition"]["commands"][number]["tag"]
      ? never
      : Tag extends Agg["definition"]["commands"][number]["tag"]
        ? Agg["aggregateName"]
        : never
    : never
  : never;

/** Every decision of `D` but the one at index `K`. */
type OtherDecisions<D extends ReadonlyArray<Decision.Any>, K> = {
  [J in keyof D]: J extends K ? never : D[J];
}[number];

/**
 * A model's decisions, each implementing a command nothing else in the
 * model implements, and reading only the model's aggregates. An entry whose
 * command an aggregate or another decision implements, or that reads an
 * aggregate the model leaves out, becomes a message naming it.
 */
export type ImplementedOnce<
  A extends ReadonlyArray<Aggregate.Any>,
  D extends ReadonlyArray<Decision.Any>,
> = {
  readonly [K in keyof D]: string extends D[K]["decisionName"]
    ? // A widened list (another model's `decisions`) names no command: checked when the model is built.
      D[K]
    : [ImplementerOf<A, D[K]["decisionName"]>] extends [never]
      ? D[K]["decisionName"] extends OtherDecisions<D, K>["decisionName"]
        ? `${D[K]["decisionName"]} is already implemented by another decision`
        : [UnhostedRead<A, D[K]>] extends [never]
          ? D[K]
          : `${D[K]["decisionName"]} reads ${UnhostedRead<A, D[K]>}, which is not in the model's aggregates`
      : `${D[K]["decisionName"]} is already implemented by ${ImplementerOf<A, D[K]["decisionName"]>}`;
};

/** The names of the aggregates `D` reads that are not among `A`. */
type UnhostedRead<A extends ReadonlyArray<Aggregate.Any>, D extends Decision.Any> = Exclude<
  D["reads"][keyof D["reads"]]["aggregateName"],
  A[number]["aggregateName"]
>;

/** What a model's members serve. */
export interface ServableBy<
  A extends ReadonlyArray<Aggregate.Any>,
  V extends ReadonlyArray<View.Any>,
  S extends ReadonlyArray<DomainStream.Any>,
  Q extends ReadonlyArray<Query.Any> = readonly [],
  D extends ReadonlyArray<Decision.Any> = readonly [],
> {
  readonly aggregates: A;
  readonly decisions: D;
  readonly commands: ReadonlyArray<
    A[number]["definition"]["commands"][number] | D[number]["command"]
  >;
  readonly views: V;
  readonly streams: S;
  readonly queries: Q;
}

type ProvidedBy<
  A extends ReadonlyArray<Aggregate.Any>,
  V extends ReadonlyArray<View.Any>,
  J extends ReadonlyArray<Projection.Any>,
  S extends ReadonlyArray<DomainStream.Any>,
  G extends ReadonlyArray<Saga.Any>,
  D extends ReadonlyArray<Decision.Any> = readonly [],
> =
  | Identifier<A[number]>
  | Identifier<D[number]>
  | Identifier<V[number]>
  | Identifier<S[number]>
  | Saga.Identifier<G[number]>
  | Projection.ProgressIdentifier<J[number]>;

/** How a model's `layer` hosts it: tuning that doesn't change what the model means. */
export interface LayerOptions<Views extends string = string> {
  /** What the hosted model records in traces. See {@link Telemetry.Options}. */
  readonly telemetry?: Telemetry.Options;
  /**
   * Before Domain version 0, models in one Worker that listed the same
   * aggregate, view or saga shared its Durable Object class, and so its data.
   * Each model now has classes of its own, and the first deploy renames the
   * shared class to the model's, keeping its data. When two models shared a
   * class, only one can keep it: set `false` on the others, which start
   * empty. The deploy fails while more than one would take it over.
   *
   * @default true
   */
  readonly legacyData?: boolean;
  /**
   * Views that fill lazily when they are added. A deploy that adds one waits
   * for nothing: each key reads its history the first time it is read (or when
   * its source next changes). Only for a view that reads one aggregate and is
   * keyed by it, so each key's history is its own instance's events. (Such a
   * view is always rebuilt this way when its `version` is bumped.)
   */
  readonly lazy?: ReadonlyArray<Views>;
}

/** Every implementation a model's `layer` requires: its policies, projections, sagas and queries. */
/** A guarded view's or stream's Layer, which provides its `validate`. */
type ValidatorOf<X> = X extends {
  readonly Validator: Context.Key<infer I, unknown>;
  readonly definition: infer D;
}
  ? // A widened view (`View.Any`) names no Layer: serving it checks at run time.
    unknown extends I
    ? never
    : Read.Guarded<D> extends true
      ? I
      : never
  : never;

type HandledBy<
  P extends ReadonlyArray<Policy.Any>,
  J extends ReadonlyArray<Projection.Any>,
  G extends ReadonlyArray<Saga.Any>,
  Q extends ReadonlyArray<Query.Any> = readonly [],
  V extends ReadonlyArray<View.Any> = readonly [],
  S extends ReadonlyArray<DomainStream.Any> = readonly [],
> =
  | Identifier<P[number]>
  | Identifier<J[number]>
  | Saga.ImplementationIdentifier<G[number]>
  | Query.Identifier<Q[number]>
  | ValidatorOf<V[number]>
  | ValidatorOf<S[number]>;

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
 * ### Deciding across aggregates
 * List each `Domain.Decision` in `decisions`. Every command has one
 * implementation, an aggregate or a decision: a second is a type error on
 * its entry.
 *
 * **Example:** A model with a decision
 * ```typescript
 * export class Bank extends Domain.Model("Bank", {
 *   aggregates: [Account],
 *   decisions: [Transfer],
 * }) {}
 * ```
 *
 * ### Annotating models
 * The last argument is its annotations: data for what is built on the
 * model, read back as `X.annotations`. Add your own keys by augmenting
 * `Domain.Annotations`.
 *
 * A model lists its declarations, so tooling can walk them and read each
 * one's annotations.
 *
 * **Example:** A description
 * ```typescript
 * export class Bank extends Domain.Model(
 *   "Bank",
 *   { aggregates: [Account], views: [AccountSummary] },
 *   { description: "Accounts and their balances." },
 * ) {}
 *
 * const glossary = Bank.commands.map((command) => `${command.tag}: ${command.annotations.description}`);
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
  const D extends ReadonlyArray<Decision.Any> = readonly [],
>(
  name: Name,
  members: Members<A, V, P, J, S, G, Q, D>,
  annotations: Annotations = {},
): ModelClass<
  Name,
  ProvidedBy<A, V, J, S, G, D>,
  HandledBy<P, J, G, Q, V, S>,
  ServableBy<A, V, S, Q, D>
> => {
  const decisions = (members.decisions ?? []) as ReadonlyArray<Decision.Any>;
  const definitions: Kernel.Definitions = {
    aggregates: members.aggregates,
    decisions,
    views: members.views ?? [],
    policies: members.policies ?? [],
    projections: members.projections ?? [],
    streams: members.streams ?? [],
    queries: members.queries ?? [],
  };
  return class {
    static readonly kind = "Model" as const;
    static readonly annotations: Annotations = annotations;
    static readonly modelName: Name = name;
    static readonly definitions: Kernel.Definitions = definitions;
    static readonly sagas: ReadonlyArray<Saga.Any> = members.sagas ?? [];
    static readonly invariants = (members.invariants ?? {}) as {
      readonly [name: string]: (model: never) => boolean;
    };
    static readonly eventually = (members.eventually ?? {}) as {
      readonly [name: string]: (model: never) => boolean;
    };
    static readonly relations = members.relations ?? {};
    static readonly aggregates = definitions.aggregates;
    static readonly decisions = decisions;
    static readonly commands = [
      ...new Set([
        ...definitions.aggregates.flatMap((aggregate) => aggregate.definition.commands),
        ...decisions.map((decision) => decision.command),
      ]),
    ];
    static readonly views = definitions.views;
    static readonly streams = definitions.streams;
    static readonly queries: ReadonlyArray<Query.Any> = members.queries ?? [];
    static layer<E, R>(
      handlers: Layer.Layer<HandledBy<P, J, G, Q, V, S>, E, R>,
      options?: LayerOptions,
    ) {
      return Layer.effectContext(
        build(
          name,
          definitions,
          handlers,
          members.sagas ?? [],
          members.queries ?? [],
          Telemetry.resolve(options?.telemetry),
          options?.legacyData ?? true,
          options?.lazy ?? [],
        ),
      );
    }
  } as unknown as ModelClass<
    Name,
    ProvidedBy<A, V, J, S, G, D>,
    HandledBy<P, J, G, Q, V, S>,
    ServableBy<A, V, S, Q, D>
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
          const now = yield* Clock.currentTimeMillis;
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
  modelName: string,
  definitions: Kernel.Definitions,
  policies: Layer.Layer<A, E, R>,
  sagas: ReadonlyArray<Saga.Any>,
  queries: ReadonlyArray<Query.Any>,
  telemetry: Telemetry.Resolved,
  legacyData: boolean,
  lazy: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    // The model's own storage: models sharing a definition never share its data.
    const platform = yield* (yield* Platform).model({
      modelName,
      id: definitions,
      sagas: sagas.map((saga) => saga.workflow._tag),
      legacyData,
    });
    const kernel = yield* Kernel.make(definitions, telemetry);
    const random = yield* SecureRandom.SecureRandom;

    const aggregateStores = new Map<string, AggregateStore>();
    const viewStores = new Map<string, ViewStore>();
    const policyStores = new Map<string, PolicyStore>();
    const projectionStores = new Map<string, ProjectionStore>();
    const streamStores = new Map<string, StreamStore>();
    // Filled once the handlers' Layer is built; pushes read it when they run.
    const validators = new Map<string, Read.AnyValidate>();
    const validatorOf = (name: string) => validators.get(name);

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
        // Assigned, not spread: a kit's `targets` is read when used, once versions are set.
        yield* platform.aggregate(aggregate, kernel.aggregateKit(aggregate, deliver)),
      );
    }
    // Decisions commit across the aggregates' stores, so they are hosted after them.
    const decisions = definitions.decisions ?? [];
    const decisionStores = new Map<string, DecisionStore>();
    if (decisions.length > 0) {
      const host = platform.decision;
      if (host === undefined) {
        return yield* Effect.die(
          new DefinitionError({
            reason: new DecisionsUnsupported({
              decisions: decisions.map((decision) => decision.decisionName),
            }),
          }),
        );
      }
      for (const decision of decisions) {
        decisionStores.set(
          decision.decisionName,
          yield* host(decision, kernel.decisionKit(decision)),
        );
      }
    }
    const viewTarget = (name: string) => kernel.targetIdOf("view", name);
    for (const name of lazy) {
      if (!kernel.inPlace("view", name))
        return yield* Effect.die(
          new DefinitionError({ reason: new LazyViewNeedsOneSource({ view: name }) }),
        );
    }
    // A view keyed by the one aggregate it reads fills each key itself, from its
    // instance's events, before the key answers: when it is lazy, and when its
    // version was bumped (it is rebuilt in place). The deploy runs no backfill for it.
    const selfFilled = new Set(
      definitions.views
        .filter(
          (view) =>
            kernel.inPlace("view", view.viewName) &&
            (lazy.includes(view.viewName) || kernel.generationOf("view", view.viewName) > 0),
        )
        .map((view) => view.viewName),
    );
    for (const view of definitions.views) {
      // Only a view that fills itself reads its keys' history on first touch; any
      // other view is filled by the deploy's backfill, and its keys apply live.
      const source = selfFilled.has(view.viewName)
        ? kernel.sourcesOf(viewTarget(view.viewName))?.[0]
        : undefined;
      viewStores.set(
        view.viewName,
        yield* platform.view(
          view,
          Object.assign(kernel.viewKit(view, deliver), {
            push: Watch.viewPush(kernel, view, validatorOf),
            ...(source === undefined ? {} : { catchUp: { source } }),
          }),
        ),
      );
    }

    for (const stream of definitions.streams) {
      streamStores.set(
        stream.streamName,
        yield* platform.stream(stream, {
          name: stream.streamName,
          push: Watch.streamPush(kernel, stream, validatorOf),
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
        random,
      );
      hosts = Context.add(hosts, aggregate, client);
      for (const command of aggregate.definition.commands) commands.set(command.tag, client);
    }
    for (const decision of decisions) {
      const client = decisionClient(
        kernel,
        decision,
        decisionStores.get(decision.decisionName)!,
        random,
      );
      hosts = Context.add(hosts, decision, client);
      // An Api and a story send every command the same way.
      commands.set(decision.command.tag, {
        send: (command, options) =>
          Effect.map(client.send(command, options), (receipt) => ({
            // The first stream it committed to: what a read takes as `atLeast`.
            stream: receipt.commits[0]?.stream ?? "",
            version: receipt.commits[0]?.version ?? 0,
            events: receipt.events,
            reply: receipt.reply,
            commits: receipt.commits,
          })),
        schedule: () => Effect.die(new Error(`${decision.decisionName} cannot be scheduled`)),
        unschedule: () => Effect.die(new Error(`${decision.decisionName} cannot be scheduled`)),
        get: () => Effect.die(new Error(`${decision.decisionName} has no state`)),
      });
    }
    const viewHosts = new Map<string, View.Host<unknown, Key.Any, unknown>>();
    for (const view of definitions.views) {
      const host = viewHost(
        kernel,
        view,
        viewStores.get(view.viewName)!,
        // Such a key reads its history before it answers: every answer has it all.
        selfFilled.has(view.viewName)
          ? Effect.succeed({ complete: true })
          : history(platform, () => viewTarget(view.viewName)),
      );
      viewHosts.set(view.viewName, host);
      hosts = Context.add(hosts, view, host);
    }
    const streamHosts = new Map<string, DomainStream.Host<Key.Any, unknown>>();
    for (const stream of definitions.streams) {
      const host = streamHost(kernel, stream, streamStores.get(stream.streamName)!);
      streamHosts.set(stream.streamName, host);
      hosts = Context.add(hosts, stream, host);
    }
    const route: Route = { kernel, aggregates: aggregateStores, views: viewStores };
    for (const projection of definitions.projections) {
      hosts = Context.add(
        hosts,
        projection.Progress,
        projectionProgress(
          route,
          projection,
          () => projectionStores.get(projection.projectionName)!,
          history(platform, () =>
            CatchUp.targetId({
              kind: "projection",
              name: projection.projectionName,
              generation: kernel.generationOf("projection", projection.projectionName),
            }),
          ),
        ),
      );
    }

    // Sagas run on the platform's workflow engine.
    if (sagas.length > 0) {
      const engine = yield* Effect.serviceOption(WorkflowEngine.WorkflowEngine);
      if (Option.isNone(engine)) {
        return yield* Effect.die(
          new DefinitionError({
            reason: new MissingWorkflowEngine({ sagas: sagas.map((saga) => saga.sagaName) }),
          }),
        );
      }
      // The model's own runs: its sagas register and start under `<model>/<saga>`.
      const modelEngine = Saga.engineFor(engine.value, modelName);
      hosts = Context.add(hosts, WorkflowEngine.WorkflowEngine, modelEngine);
      for (const saga of sagas) hosts = Context.add(hosts, saga, Saga.client(saga, modelEngine));
    }

    // Policies, projections and sagas are built with the clients available, then hosted.
    const implementations = yield* Layer.build(policies).pipe(Effect.provide(hosts));
    // Each guarded view's and stream's `validate`, traced as `Domain.validate <Name>`.
    for (const [name, entry] of [
      ...definitions.views.map((view) => [view.viewName, view] as const),
      ...definitions.streams.map((stream) => [stream.streamName, stream] as const),
    ]) {
      const implementation = Context.getOption(
        implementations as Context.Context<unknown>,
        entry.Validator as Context.Key<unknown, Read.Implementation>,
      );
      if (Option.isNone(implementation)) {
        if (Read.isGuarded(entry.definition)) {
          return yield* Effect.die(
            new DefinitionError({ reason: new UnvalidatedRead({ entity: name }) }),
          );
        }
        continue;
      }
      const validate = implementation.value.validate as Read.AnyValidate;
      validators.set(name, (request, state) =>
        validate(request, state).pipe(
          Effect.withSpan(`Domain.validate ${name}`, {
            attributes: { "domain.read": name, "domain.mode": request.mode },
          }),
        ),
      );
    }
    const implementationOf = (projection: Projection.Any) =>
      Context.getUnsafe(
        implementations as Context.Context<unknown>,
        projection as Context.Key<unknown, Projection.Implementation<unknown>>,
      );
    for (const projection of definitions.projections) {
      const version = implementationOf(projection).options.version;
      if (version) kernel.setVersion(`projection:${projection.projectionName}`, version);
    }
    for (const projection of definitions.projections) {
      const implementation = implementationOf(projection);
      const writes = (projection.definition.writes ?? []).map((stream) =>
        streamStores.get(stream.streamName)!,
      );
      projectionStores.set(
        projection.projectionName,
        yield* platform.projection(projection, {
          name: projection.projectionName,
          options: { batch: Projection.batchMillis(implementation.options) },
          generation: kernel.generationOf("projection", projection.projectionName),
          singleSource: kernel.singleSource(`projection:${projection.projectionName}`),
          history: kernel.history,
          run: (key, batch) =>
            Effect.gen(function* () {
              // Platforms run handlers inside their runtime (a Durable Object, or this process).
              const inputs = yield* kernel.projectionInputs(projection, key, batch);
              // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the platform runs handlers inside its runtime, which provides RuntimeContext
              yield* implementation.handle(inputs) as Effect.Effect<void>;
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
    // Every store is built: catch up the consumers that are new to the platform.
    // Lazy views have no backfill: their keys catch up when read.
    const lazyTargets = new Set([...selfFilled].map(viewTarget));
    // Every consumer is in the model, so its sources route to it; those that fill
    // themselves get no backfill.
    if (platform.start)
      yield* platform.start(
        kernel.targets,
        kernel.planOf,
        kernel.targets.filter((target) => !lazyTargets.has(target)),
      );

    // Queries run where the Api runs, reading your store and the model's members.
    const queryHosts = new Map<string, Query.Host>();
    const progressOf = (projection: Projection.Any) =>
      Context.getUnsafe(hosts, projection.Progress as Context.Key<unknown, Projection.Progress>);
    const caughtUpOf = (read: Query.Waitable): Query.CaughtUp => {
      if (read.kind === "Projection") return progressOf(read).caughtUp;
      if (read.kind === "View") return viewCaughtUp(route, read);
      // A stream is caught up once every projection that writes it is.
      const writers = definitions.projections.filter((projection) =>
        (projection.definition.writes ?? []).includes(read),
      );
      return (receipt, options) =>
        Effect.forEach(writers, (writer) => progressOf(writer).caughtUp(receipt, options), {
          discard: true,
        });
    };
    // The kernel has refused duplicate names and unknown projections.
    for (const query of queries) {
      const implementation = Context.getUnsafe(
        implementations as Context.Context<unknown>,
        query as Context.Key<unknown, Query.Implementation>,
      );
      queryHosts.set(query.queryName, Query.host(query, implementation, hosts, caughtUpOf));
    }
    const caughtUp = new Map<string, Query.CaughtUp>();
    for (const view of definitions.views) caughtUp.set(view.viewName, caughtUpOf(view));
    for (const stream of definitions.streams ?? []) {
      caughtUp.set(stream.streamName, caughtUpOf(stream));
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
      validators,
      caughtUp,
      applied: viewsApplied(
        route,
        definitions.views.map((view) => ({
          view,
          // A view that fills its own keys reads their history before it answers.
          history: selfFilled.has(view.viewName)
            ? Effect.succeed({ complete: true })
            : history(platform, () => viewTarget(view.viewName)),
        })),
      ),
    });
  });

const aggregateClient = (
  kernel: Kernel.Kernel,
  aggregate: Aggregate.Any,
  store: AggregateStore,
  random: SecureRandom.SecureRandom["Service"],
): Aggregate.ClientImpl => {
  /** What a send carries besides the command: its id, context, flow and trace. */
  const metaFor = (
    target: unknown,
    command: { readonly _tag: string },
    options: Aggregate.SendOptions | undefined,
    link: boolean,
  ) =>
    Effect.gen(function* () {
      const commandId = yield* Aggregate.commandIdFor(options, random);
      const context = yield* RequestContext.capture;
      const correlationId = yield* Telemetry.correlationFor(commandId);
      yield* Effect.annotateCurrentSpan({
        "domain.command_id": commandId,
        "domain.correlation_id": correlationId,
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
  /** The instance a command is for, from the aggregate's `keyOf`. */
  const targetFor = (command: { readonly _tag: string }): Effect.Effect<string> =>
    Effect.suspend(() => {
      const target = Aggregate.targetOf(aggregate, command);
      return target === undefined
        ? Effect.die(
            new DefinitionError({
              reason: new UnhandledCommand({
                aggregate: aggregate.aggregateName,
                command: command._tag,
              }),
            }),
          )
        : Effect.succeed(target);
    });
  return {
    send: (command, options) =>
      Effect.gen(function* () {
        const target = yield* targetFor(command);
        // The span records a rejection as an outcome; the caller still fails with it.
        const result = yield* Effect.gen(function* () {
          const { id, meta } = yield* metaFor(target, command, options, false);
          const encoded = yield* kernel.encodeCommand(aggregate, command);
          const result = yield* store.send(id, encoded, meta);
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
          : yield* kernel.decodeReceipt(aggregate, command._tag, result.receipt);
      }),
    schedule: (command, options) =>
      Effect.gen(function* () {
        const target = yield* targetFor(command);
        // The command runs later, so its span links back here rather than continuing this trace.
        // `commandId` names the scheduled command; the arming gets its own id, derived like a
        // send's, so a policy or step that runs again arms nothing new, and a later trigger
        // arms the name again even after its command ran.
        const { id, meta } = yield* metaFor(target, command, undefined, true);
        const name = options.commandId ?? meta.commandId;
        const at = yield* store.schedule(
          id,
          name,
          yield* kernel.encodeCommand(aggregate, command),
          meta,
          options.at !== undefined
            ? { at: DateTime.toEpochMillis(options.at) }
            : { afterMillis: Duration.toMillis(Duration.fromInputUnsafe(options.after)) },
        );
        return { commandId: name, at: DateTime.makeUnsafe(at) };
      }).pipe(
        Effect.withSpan(`Domain.schedule ${aggregate.aggregateName}.${command._tag}`, {
          kind: "client",
          attributes: { "domain.aggregate": aggregate.aggregateName },
        }),
      ),
    unschedule: (target, commandId) =>
      store.unschedule(Aggregate.targetId(target), commandId).pipe(
        Effect.withSpan(`Domain.unschedule ${aggregate.aggregateName}`, {
          ...spanOptions(target),
          attributes: { ...spanOptions(target).attributes, "domain.command_id": commandId },
        }),
      ),
    get: (target) =>
      store
        .state(Aggregate.targetId(target))
        .pipe(Effect.map(({ state }) => kernel.decodeState(aggregate, state))),
  };
};

const decisionClient = (
  kernel: Kernel.Kernel,
  decision: Decision.Any,
  store: DecisionStore,
  random: SecureRandom.SecureRandom["Service"],
): Decision.ClientImpl => ({
  send: (command, options) =>
    Effect.gen(function* () {
      // The span records a rejection as an outcome; the caller still fails with it.
      const result = yield* Effect.gen(function* () {
        const commandId = yield* Aggregate.commandIdFor(options, random);
        const context = yield* RequestContext.capture;
        const correlationId = yield* Telemetry.correlationFor(commandId);
        yield* Effect.annotateCurrentSpan({
          "domain.command_id": commandId,
          "domain.correlation_id": correlationId,
        });
        const trace = yield* Telemetry.currentTrace;
        const result = yield* store.send(yield* kernel.encodeDecisionCommand(decision, command), {
          commandId,
          context,
          correlationId,
          ...(trace ? { trace } : {}),
        });
        yield* Effect.annotateCurrentSpan(
          "domain.outcome",
          result._tag === "Accepted"
            ? "accepted"
            : ((result.rejection as { readonly _tag?: string })._tag ?? "rejected"),
        );
        return result;
      }).pipe(
        Effect.withSpan(`Domain.send ${decision.decisionName}`, {
          kind: "client",
          attributes: { "domain.decision": decision.decisionName },
        }),
      );
      return result._tag === "Rejected"
        ? yield* Effect.fail(kernel.decodeDecisionRejection(decision, result.rejection))
        : yield* kernel.decodeDecisionReceipt(decision, result.receipt);
    }),
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
  history: Effect.Effect<View.History>,
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
    const poll = read.pipe(
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
    );
    return Effect.gen(function* () {
      const wait = yield* RunWait;
      return yield* wait(poll);
    }).pipe(
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
    history,
    get: (key, options) =>
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
        Stream.mapEffect((entry) => kernel.decodeViewEntry(view, entry)),
        Stream.filter((entry) => matches(options?.where, entry.event)),
      ),
    list: (key, options) =>
      listPage(
        (range) => store.list(Aggregate.targetId(key), range),
        (row) => kernel.decodeViewEntry(view, row),
        options,
      ),
  };
};

/** How many entries a filtered `list` reads at a time, at least. */
const LIST_BATCH = 128;

/**
 * A page of a key's entries. Order, cursor and size go to the store, so it
 * reads the page and one entry more (to know there is a next page), not the
 * whole key. A filter reads in batches until it has them.
 */
const listPage = <Row extends { readonly seq: number }, E, A extends { readonly event: E }>(
  read: (range: ListRange) => Effect.Effect<ReadonlyArray<Row>>,
  decode: (row: Row) => Effect.Effect<A>,
  options:
    | {
        readonly where?: Filter<E>;
        readonly order?: "asc" | "desc";
        readonly take?: number;
        readonly after?: number;
      }
    | undefined,
): Effect.Effect<View.Page<A>> =>
  Effect.gen(function* () {
    const take = options?.take === undefined ? undefined : Math.max(0, options.take);
    const where = options?.where;
    const limit =
      take === undefined
        ? undefined
        : where === undefined
          ? take + 1
          : Math.max(take + 1, LIST_BATCH);
    const page: Array<A> = [];
    let last: number | null = null;
    let after = options?.after;
    for (;;) {
      const rows = yield* read({
        ...(options?.order === undefined ? {} : { order: options.order }),
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      });
      for (const row of rows) {
        const entry = yield* decode(row);
        if (!matches(where, entry.event)) continue;
        // One more match than the page: there is a next page, after the page's last entry.
        if (page.length === take) return { entries: page, cursor: page.length > 0 ? last : null };
        page.push(entry);
        last = row.seq;
      }
      if (limit === undefined || rows.length < limit) return { entries: page, cursor: null };
      after = rows[rows.length - 1]!.seq;
    }
  });

/** The pause between two tries of a progress check. */
const WAIT_PAUSE = Duration.millis(25);

/**
 * Wait until a progress check passes, retrying every 25ms up to `timeout`.
 *
 * The pause is for other work to finish (a view applying an event), not a
 * moment in the domain's time, so it runs on the real clock: a test clock
 * nobody advances must not hold a command or a read forever. A platform
 * that manages its runs' waits (`RunWait`) paces the pauses itself.
 */
const waitUntil = <A>(
  check: Effect.Effect<A, "stale">,
  timeout: Duration.Input | undefined,
  onTimeout: () => View.ConsistencyTimeout,
) =>
  Effect.gen(function* () {
    const wait = yield* RunWait;
    const pause =
      wait === runDirectly
        ? Clock.Clock.defaultValue().sleep(WAIT_PAUSE)
        : Effect.sleep(WAIT_PAUSE);
    const tries = Math.ceil(
      Duration.toMillis(Duration.fromInputUnsafe(timeout ?? "10 seconds")) /
        Duration.toMillis(WAIT_PAUSE),
    );
    const attempt = (left: number): Effect.Effect<A, "stale"> =>
      Effect.catch(check, (stale) =>
        left <= 0
          ? Effect.fail(stale)
          : Effect.andThen(
              pause,
              Effect.suspend(() => attempt(left - 1)),
            ),
      );
    return yield* wait(attempt(tries));
  }).pipe(Effect.mapError(onTimeout));

const streamHost = (
  kernel: Kernel.Kernel,
  stream: DomainStream.Any,
  store: StreamStore,
): DomainStream.Host<Key.Any, unknown> => {
  const decode = (entry: StreamEntry) => kernel.decodeStreamEntry(entry);
  const latest = (key: string, meta: StreamMeta) =>
    meta.seq === 0
      ? Effect.succeedNone
      : store.tail(key, meta.seq - 1).pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (entry) => Effect.asSome(decode(entry)),
            }),
          ),
        );
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
        Stream.mapEffect(decode),
        Stream.filter((entry) => matches(options?.where, entry.event)),
      ),
    list: (key, options) =>
      listPage((range) => store.list(Aggregate.targetId(key), range), decode, options),
    append: (origin, ...events) =>
      Effect.suspend(() => {
        const meta = (origin as unknown as Record<symbol, Kernel.InputMetaValue | undefined>)[
          Kernel.InputMeta
        ];
        const writer = kernel.writerOf(stream);
        if (!meta || !writer || writer.projectionName !== meta.projection) {
          return Effect.die(
            new DefinitionError({ reason: new ForeignAppend({ stream: stream.streamName }) }),
          );
        }
        meta.appends += 1;
        const position: [number, number] = [meta.position, meta.appends];
        return Effect.forEach(events, (event) =>
          kernel.encodeEvent(event as { readonly _tag: string }),
        ).pipe(
          Effect.flatMap((encoded) =>
            store.append(meta.key, {
              origin: position,
              source: meta.source,
              sourceSeq: meta.sourceSeq,
              at: meta.at,
              commandId: meta.commandId,
              events: encoded,
            }),
          ),
        );
      }),
  };
};

/** How much history has reached a consumer, as the platform reports it. */
const history = (platform: ModelHost, target: () => string): Effect.Effect<View.History> =>
  Effect.suspend(() =>
    platform.history
      ? Effect.map(platform.history(target()), ({ complete }) => ({ complete }))
      : Effect.succeed({ complete: true }),
  );
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

/** The stores a command's events pass through on their way to a view or projection. */
interface Route {
  readonly kernel: Kernel.Kernel;
  readonly aggregates: ReadonlyMap<string, AggregateStore>;
  readonly views: ReadonlyMap<string, ViewStore>;
}

/** What `caughtUp` is handed: a command's receipt, with or without its events. */
interface CaughtUpReceipt {
  readonly stream: string;
  readonly version: number;
  readonly events?: ReadonlyArray<unknown>;
}

/**
 * One event on a command's way to a consumer: one the command committed to
 * its aggregate instance, or one a view key emitted for it. A consumer of
 * `source` hears it at `stream`/`seq`.
 */
interface Reached {
  readonly source: string;
  readonly id: string;
  readonly stream: string;
  readonly seq: number;
  readonly event: { readonly _tag: string };
  /** A view's encoded state after it emitted the event. */
  readonly state?: Json;
}

/** A view key once it has applied a command's events: see `applied` in {@link follow}. */
interface AppliedKey {
  readonly key: string;
  /** The position it had to reach on each source stream. */
  readonly streams: ReadonlyMap<string, number>;
  readonly snapshot: ViewSnapshot;
  /** Its cursor before it applied them; `undefined` if it had when first read. */
  readonly before: number | undefined;
}

/**
 * Follow a command's events from its aggregate through every view between it
 * and a consumer, waiting for each view to apply them on the way. Every wait
 * shares one `timeout`.
 */
const follow = (route: Route, receipt: CaughtUpReceipt, timeout: Duration.Input | undefined) =>
  Effect.gen(function* () {
    const { kernel } = route;
    const [aggregate = "", ...rest] = receipt.stream.split("/");
    const id = rest.join("/");
    const store = route.aggregates.get(aggregate);
    const deadline =
      (yield* Clock.currentTimeMillis) +
      Duration.toMillis(Duration.fromInputUnsafe(timeout ?? "10 seconds"));
    /** Retry `check` until it holds or the deadline passes. */
    const until = <A>(check: Effect.Effect<A, "stale">, onTimeout: () => View.ConsistencyTimeout) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        waitUntil(check, Duration.millis(Math.max(0, deadline - now)), onTimeout),
      );

    let stored: ReadonlyArray<StoredEvent> | undefined;
    /** The command's committed events, read once from its aggregate. */
    const read: Effect.Effect<ReadonlyArray<StoredEvent>> = store
      ? commandEvents(store, id, receipt.version)
      : Effect.succeed([]);
    const committed = Effect.suspend(() =>
      stored !== undefined
        ? Effect.succeed(stored)
        : Effect.tap(read, (events) =>
            Effect.sync(() => {
              stored = events;
            }),
          ),
    );
    // A receipt from a client carries no events: read them from the aggregate.
    const fromAggregate: Effect.Effect<ReadonlyArray<Reached>> =
      receipt.events !== undefined
        ? Effect.succeed(
            receipt.events.map((event, index) => ({
              source: aggregate,
              id,
              stream: receipt.stream,
              seq: receipt.version - receipt.events!.length + 1 + index,
              event: event as { readonly _tag: string },
            })),
          )
        : Effect.flatMap(committed, (events) =>
            Effect.forEach(events, (event) =>
              Effect.map(kernel.decodeEvent(event.event), (decoded) => ({
                source: aggregate,
                id,
                stream: receipt.stream,
                seq: event.envelope.seq,
                event: decoded as { readonly _tag: string },
              })),
            ),
          );

    /** The positions, per key, a consumer must reach on each stream. */
    const positions = (
      reached: ReadonlyArray<Reached>,
      keysOf: (reached: Reached) => ReadonlyArray<string>,
    ) => {
      const waits = new Map<string, Map<string, number>>();
      for (const r of reached) {
        for (const key of keysOf(r)) {
          const streams = waits.get(key) ?? new Map<string, number>();
          waits.set(key, streams);
          streams.set(r.stream, Math.max(streams.get(r.stream) ?? 0, r.seq));
        }
      }
      return waits;
    };

    /**
     * Wait until a view has applied every event in `reached` it consumes, and
     * return, per key it reaches: the positions it had to reach on each
     * source, its snapshot once it had, and its cursor before them
     * (`undefined` when it had applied them before we looked).
     */
    const applied = (view: View.Any, reached: ReadonlyArray<Reached>, only?: string) =>
      Effect.gen(function* () {
        const viewStore = route.views.get(view.viewName)!;
        const waits = positions(reached, (r) =>
          kernel.viewKeys(view, r.source, r.id, r.event, r.seq, r.state),
        );
        return yield* Effect.forEach(
          only === undefined ? waits : [...waits].filter(([key]) => key === only),
          ([key, streams]) =>
            Effect.gen(function* () {
              const missing = (snapshot: ViewSnapshot) =>
                [...streams].find(([stream, seq]) => (snapshot.checkpoints[stream] ?? 0) < seq);
              const first = yield* viewStore.read(key);
              const unapplied = missing(first);
              if (unapplied === undefined) {
                return { key, streams, snapshot: first, before: undefined } satisfies AppliedKey;
              }
              const [stream, version] = unapplied;
              const snapshot = yield* until(
                viewStore
                  .read(key)
                  .pipe(
                    Effect.flatMap((snapshot) =>
                      missing(snapshot) === undefined
                        ? Effect.succeed(snapshot)
                        : Effect.fail("stale" as const),
                    ),
                  ),
                () => View.ConsistencyTimeout.make({ view: view.viewName, key, stream, version }),
              );
              return { key, streams, snapshot, before: first.seq } satisfies AppliedKey;
            }),
          { concurrency: "unbounded" },
        );
      });

    /** A view key's entry, as an event that reaches the view's consumers. */
    const reachedFrom = (view: View.Any, key: string, entry: ViewEntry) =>
      Effect.map(kernel.decodeEvent(entry.event), (event): Reached => ({
        source: view.viewName,
        id: key,
        stream: `${view.viewName}/${key}`,
        seq: entry.seq,
        event: event as { readonly _tag: string },
        state: entry.state,
      }));

    /**
     * What a view key emitted for the command. When the key's snapshot records
     * the command as the last to reach it from each source, its entries are
     * read by range. Otherwise (a later command reached it first, or the
     * snapshot predates the record) they are found by the command's id,
     * newest first, back to the key's cursor before the command (`before`)
     * or, without it, to the first entry before the command's.
     */
    const emitted = (view: View.Any, { key, streams, snapshot, before }: AppliedKey) =>
      Effect.gen(function* () {
        const viewStore = route.views.get(view.viewName)!;
        const ranges = [...streams].map(([stream, seq]) => {
          const range = snapshot.emitted?.[stream];
          return range?.sourceSeq === seq ? range : undefined;
        });
        if (ranges.every((range) => range !== undefined)) {
          const bySeq = new Map<number, ViewEntry>();
          for (const range of ranges as ReadonlyArray<EmittedRange>) {
            if (range.through <= range.after) continue;
            const entries = yield* viewStore.list(key, {
              after: range.after,
              limit: range.through - range.after,
            });
            for (const entry of entries) {
              if (entry.envelope.commandId === range.commandId) bySeq.set(entry.seq, entry);
            }
          }
          return yield* Effect.forEach(bySeq.values(), (entry) => reachedFrom(view, key, entry));
        }
        const commandId = (yield* committed).at(-1)?.envelope.commandId;
        if (commandId === undefined) return [];
        const out: Array<Reached> = [];
        let after = snapshot.seq + 1;
        for (let limit = 8; ; limit *= 4) {
          const page = yield* viewStore.list(key, { order: "desc", after, limit });
          for (const entry of page) {
            if (before !== undefined && entry.seq <= before) return out;
            if (entry.envelope.commandId === commandId) {
              out.push(yield* reachedFrom(view, key, entry));
            } else if (before === undefined && out.length > 0) return out;
          }
          if (page.length < limit) return out;
          after = page[page.length - 1]!.seq;
        }
      });

    const reachedOf = new Map<string, ReadonlyArray<Reached>>();
    /** Every event of the command that reaches a consumer of `source`. */
    const reach = (
      source: View.Source,
    ): Effect.Effect<ReadonlyArray<Reached>, View.ConsistencyTimeout> =>
      Effect.gen(function* () {
        if (source.kind === "Aggregate") {
          return (source as Aggregate.Any).aggregateName === aggregate ? yield* fromAggregate : [];
        }
        const view = source as View.Any;
        const known = reachedOf.get(view.viewName);
        if (known) return known;
        const keys = yield* applied(view, yield* upstream(view));
        const out = (yield* Effect.forEach(keys, (key) => emitted(view, key), {
          concurrency: "unbounded",
        })).flat();
        reachedOf.set(view.viewName, out);
        return out;
      });
    /** Every event of the command that reaches a consumer of all of `sources`. */
    const upstream = (consumer: View.Any | Projection.Any) =>
      Effect.map(
        Effect.forEach(consumer.definition.from as ReadonlyArray<View.Source>, reach),
        (all) => all.flat(),
      );

    return { until, positions, applied, upstream };
  });

/**
 * Wait until a view has applied a command's events on every key they reach
 * (or on `key` alone, for a read of one key), through any views between it
 * and the command's aggregate, so a read sees the caller's write.
 */
const viewCaughtUp =
  (route: Route, view: View.Any): Query.CaughtUp =>
  (receipt, options) =>
    Effect.gen(function* () {
      const chain = yield* follow(route, receipt, options?.timeout);
      yield* chain.applied(view, yield* chain.upstream(view), options?.key);
    });

/**
 * Wait until every view has applied a command's events, on every key they
 * reach. A view still receiving its history is skipped: it would hold every
 * command up for as long as the backfill runs, and its readers already know
 * it is behind (`history`). Once a view's history is complete it stays so.
 */
const viewsApplied = (
  route: Route,
  views: ReadonlyArray<{
    readonly view: View.Any;
    readonly history: Effect.Effect<View.History>;
  }>,
) => {
  const complete = new Set<string>();
  const current = Effect.forEach(
    views,
    ({ view, history }) =>
      complete.has(view.viewName)
        ? Effect.succeed([view])
        : Effect.map(history, (reached) => {
            if (!reached.complete) return [];
            complete.add(view.viewName);
            return [view];
          }),
    { concurrency: "unbounded" },
  );
  return (
    receipt: Aggregate.Receipt,
    options?: { readonly timeout?: Duration.Input },
  ): Effect.Effect<void, View.ConsistencyTimeout> =>
    Effect.gen(function* () {
      if (views.length === 0) return;
      // An aggregate's command has its events in hand; a decision's are read per stream.
      const single = receipt.commits.length <= 1;
      if (single && receipt.events.length === 0) return;
      const waited = (yield* current).flat();
      if (waited.length === 0) return;
      const commits: ReadonlyArray<CaughtUpReceipt> = single
        ? [{ stream: receipt.stream, version: receipt.version, events: receipt.events }]
        : receipt.commits;
      yield* Effect.forEach(
        commits,
        Effect.fn(function* (commit) {
          const chain = yield* follow(route, commit, options?.timeout);
          yield* Effect.forEach(
            waited,
            (view) =>
              Effect.flatMap(chain.upstream(view), (reached) => chain.applied(view, reached)),
            { concurrency: "unbounded", discard: true },
          );
        }),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.withSpan("Domain.applied", { attributes: { "domain.stream": receipt.stream } }));
};

/**
 * A projection's progress. `caughtUp` follows a command's events from its
 * aggregate through every view between it and the projection, then waits
 * until the projection has handled what reaches it.
 */
const projectionProgress = (
  route: Route,
  projection: Projection.Any,
  store: () => ProjectionStore,
  history: Effect.Effect<View.History>,
): Projection.Progress => ({
  history,
  caughtUp: (receipt, options) =>
    Effect.gen(function* () {
      const chain = yield* follow(route, receipt, options?.timeout);
      const waits = chain.positions(yield* chain.upstream(projection), (r) =>
        route.kernel.projectionKeys(projection, r.source, r.id, r.event, r.seq, r.state),
      );
      // One read of a key's checkpoints covers every stream it waits on.
      yield* Effect.forEach(
        waits,
        ([key, streams]) => {
          let missing: readonly [string, number] = [...streams][0]!;
          return chain.until(
            store()
              .checkpoints(key)
              .pipe(
                Effect.flatMap((checkpoints) => {
                  const behind = [...streams].find(
                    ([stream, seq]) => (checkpoints[stream] ?? 0) < seq,
                  );
                  if (behind === undefined) return Effect.void;
                  missing = behind;
                  return Effect.fail("stale" as const);
                }),
              ),
            () =>
              View.ConsistencyTimeout.make({
                view: projection.projectionName,
                key,
                stream: missing[0],
                version: missing[1],
              }),
          );
        },
        { concurrency: "unbounded", discard: true },
      );
    }),
});
