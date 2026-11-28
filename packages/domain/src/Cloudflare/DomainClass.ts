import {
  DurableObjectCallbacks,
  outsideAlarmPass,
} from "@alchemy.run/cloudflare/Workers/AlarmCallback";
import {
  DurableObject as CloudflareDurableObject,
  type DurableObjectGetDurableObjectOptions,
  type DurableObjectJurisdiction,
  type InlineDurableObjectProps,
} from "@alchemy.run/cloudflare/Workers/DurableObject";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import { upgrade } from "@alchemy.run/cloudflare/Workers/WebSocket";
import { type Worker, Worker as CloudflareWorker } from "@alchemy.run/cloudflare/Workers/Worker";
import { WorkerEnvironment } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import { Workflow, type WorkflowImpl } from "@alchemy.run/cloudflare/Workflows/Workflow";
import { RuntimeContext } from "alchemy/RuntimeContext";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Backfill from "../Backfill.ts";
import {
  type ObjectImpl as DomainObjectImpl,
  ObjectState,
  type ObjectStateShape,
  type Stub as DomainStub,
} from "../DurableObjects.ts";
import type { Delivery } from "../Platform.ts";
import { MIGRATION_ROUTE, migration, migrationObject } from "./Migration.ts";
import { legacyObject, router } from "./Router.ts";
import { MIGRATION_WORKFLOW } from "./Version.ts";

/**
 * A Domain model's one Durable Object class on a Worker, named after the
 * model: `Billing.Domain`. Each object in it is named `definition/key`
 * (`Billing.AccountAggregate/a-1`) and runs that definition's code (see
 * `Router.ts`). A Worker declares one class per model however many
 * definitions it has, so removing a model deletes its class.
 *
 * `domainClass(random, "Billing")` declares the class the first time a model
 * is provided on a Worker and hands back the same one after: its definitions
 * add their routes to it, and the deploy's migration reaches it (see
 * `Migration.ts`) while a Worker upgraded from an older layout still has
 * the old classes.
 */

export const domainClassName = (modelName: string) =>
  `${modelName}.Domain`.replace(/[^A-Za-z0-9_.]/g, "_");

export type Stub = DomainStub;

/** A Cloudflare Durable Object namespace: Domain's, plus fetch and jurisdictions. */
export interface Namespace {
  readonly getByName: (
    name: string,
    options?: DurableObjectGetDurableObjectOptions,
  ) => Stub & {
    readonly fetch: (
      request: HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
  };
  readonly jurisdiction: (jurisdiction: DurableObjectJurisdiction) => Namespace;
}

/** What a Cloudflare instance's methods and constructor run with. */
type InstanceServices = DurableObjectState | RuntimeContext | Scope.Scope;

/** The usual outer (construction) / inner (instance) pair. */
export type ObjectImpl = Effect.Effect<
  Effect.Effect<Record<string, unknown>, never, InstanceServices>,
  never,
  DurableObjectState
>;

/**
 * Declare a Durable Object class on the host Worker from inside a factory.
 * The inline form of `Cloudflare.DurableObject` is typed for single-stage
 * implementations, so it is re-typed here for the two-stage form it runs.
 */
export const declare = CloudflareDurableObject as unknown as (
  name: string,
  props: InlineDurableObjectProps,
  impl: ObjectImpl,
) => Effect.Effect<Namespace, never, Worker>;

/** Domain's view of a Cloudflare Durable Object's state. */
export const objectState = (
  state: DurableObjectState["Service"],
  runtime: RuntimeContext["Service"],
): ObjectStateShape => ({
  storage: state.storage as unknown as ObjectStateShape["storage"],
  // Durable Objects run each event in its own I/O context, so in-memory
  // coordination across events is unsafe; the platform's gate is not.
  exclusive: (effect) =>
    Effect.flatMap(
      state.blockConcurrencyWhile(() => Effect.exit(effect)),
      (exit) => exit,
    ).pipe(Effect.provideService(RuntimeContext, runtime)),
  // Background work outside the alarm pass, so a callback's alarm isn't held open by it.
  waitUntil: (effect) =>
    state.waitUntil(outsideAlarmPass(effect)).pipe(Effect.provideService(RuntimeContext, runtime)),
  sockets: {
    accept: () =>
      Effect.provideService(upgrade(), DurableObjectState, state) as unknown as ReturnType<
        NonNullable<ObjectStateShape["sockets"]>["accept"]
      >,
    all: () =>
      state.getWebSockets() as unknown as ReturnType<
        NonNullable<ObjectStateShape["sockets"]>["all"]
      >,
  },
});

/** Run a Domain object on a Cloudflare Durable Object class. */
export const onCloudflare = (impl: DomainObjectImpl): ObjectImpl =>
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const runtime = yield* RuntimeContext;
      return yield* impl.pipe(
        Effect.provideService(ObjectState, objectState(state, runtime)),
        Effect.provide(DurableObjectCallbacks),
      );
    }),
  );

/**
 * A class a route's objects may still be on: its Domain version 0 class
 * (`Billing.AccountAggregate`), or the class it was before versions
 * (`AccountAggregate`), which keeps its name and is reached by a binding of
 * the model's own (`Billing.AccountAggregate.BeforeVersions`). Renaming it
 * would list it twice in the upload, and a Worker with many definitions would
 * pass Cloudflare's limit of 100 exports (#2976).
 */
export interface LegacyClass {
  readonly className: string;
  /** The binding the code reaches the class by. */
  readonly binding: string;
  /** From before Domain versions: that code listed none of its objects. */
  readonly beforeVersions?: boolean;
}

/** The objects of one route, in the shared class. */
export const routeView = (namespace: Namespace, route: string): Namespace => ({
  getByName: (key, options) => namespace.getByName(`${route}/${key}`, options),
  jurisdiction: (jurisdiction) => routeView(namespace.jurisdiction(jurisdiction), route),
});

export interface Classes {
  /** The model's class, `Billing.Domain`: its name and its binding. */
  readonly className: string;
  /** Every route the model hosts, and its implementation. */
  readonly routes: Map<string, ObjectImpl>;
  /** The binding of each route's old class, while the code still moves its objects. */
  readonly movers: Map<string, string>;
  readonly namespace: Namespace;
  /** The migration Workflow's name, as deployed. */
  readonly workflowName: unknown;
  readonly env: Record<string, any> | undefined;
  /** Where the migration run's job tokens come from. */
  readonly random: Random;
  /** How a migration run finds every object of the model: set once the model is built. */
  resolver?: Resolver;
}

/**
 * How a migration run finds every object of a model without Cloudflare's
 * object listing, which lags behind recent writes: the model's directory lists
 * every object, and each source's history names the consumer objects it
 * reached. Routes are class names in the model's class (`Billing.NotifyPolicy`).
 */
export interface Resolver {
  /** The model's class, in the model's jurisdiction. */
  readonly namespace: Namespace;
  /** The route of the model's directory nodes, `Billing.DomainDirectory`. */
  readonly directory: string;
  /**
   * The route of a directory entry's objects, and whether it is a source (an
   * aggregate or view, whose history names consumers); `undefined` for one
   * this code doesn't host.
   */
  readonly entry: (
    ref: Backfill.SourceRef,
  ) => { readonly route: string; readonly source: boolean } | undefined;
  /** A consumer's routes: its keys', and its run's (root, relays and scanners). */
  readonly consumer: (
    target: Delivery["target"],
  ) => { readonly keys: string; readonly run: string } | undefined;
  /** The routes of the streams a projection writes, keyed like the projection. */
  readonly streams: (projection: string) => ReadonlyArray<string>;
  /** The routes of every consumer's run, whose root records its history. */
  readonly runs: () => ReadonlyArray<string>;
  /** The name of a source instance's scanner in a consumer's run. */
  readonly scanner: (ref: Backfill.SourceRef) => string;
}

/** What makes job tokens: the platform's secure random source. */
export type Random = SecureRandom.SecureRandom["Service"];

/** Each model's class, per Worker. */
const workers = new WeakMap<object, Map<string, Classes>>();

/** The migration Workflow of each Worker: one moves every model's objects. */
const migrationWorkflows = new WeakMap<object, { readonly workflowName: unknown }>();

/** The class of `modelName` on the host Worker, declared on first use. */
export const domainClass = Effect.fn(function* (random: Random, modelName: string) {
  const host = yield* CloudflareWorker;
  let models = workers.get(host);
  if (models === undefined) workers.set(host, (models = new Map()));
  let classes = models.get(modelName);
  if (classes === undefined) {
    const className = domainClassName(modelName);
    const routes = new Map<string, ObjectImpl>();
    const movers = new Map<string, string>();
    const namespace = yield* declare(
      className,
      {},
      router(routes, movers, () => classes!),
    );
    let workflow = migrationWorkflows.get(host);
    if (workflow === undefined) {
      workflow = (yield* Workflow(
        MIGRATION_WORKFLOW,
        Effect.succeed(migration) as unknown as Effect.Effect<WorkflowImpl<any, any, unknown>>,
      )) as { readonly workflowName: unknown };
      migrationWorkflows.set(host, workflow);
    }
    classes = {
      className,
      routes,
      movers,
      namespace,
      workflowName: workflow.workflowName,
      // The Worker's bindings, at runtime: the old classes' among them.
      env: Option.getOrUndefined(yield* Effect.serviceOption(WorkerEnvironment)),
      random,
    };
    models.set(modelName, classes);
    // The migration run's root and relays: see `migration`.
    routes.set(MIGRATION_ROUTE, onCloudflare(migrationObject(classes)));
  }
  const shared = classes;
  return {
    /** The model's class, `Billing.Domain`. */
    className: shared.className,
    /** How a migration run finds the model's objects. */
    resolve: (resolver: Resolver) =>
      Effect.sync(() => {
        shared.resolver = resolver;
      }),
    /** The migration Workflow's name, as deployed: for the deploy's migration run. */
    workflowName: shared.workflowName,
    /**
     * Host `route`'s objects in the shared class. `legacy` lists the classes
     * they may still be on, declared too and running the same code, so a Worker
     * upgraded from one moves their storage over (see `Router.ts`).
     */
    object: (route: string, impl: ObjectImpl, legacy: ReadonlyArray<LegacyClass> = []) =>
      Effect.gen(function* () {
        shared.routes.set(route, impl);
        if (shared.movers.has(route)) return routeView(shared.namespace, route);
        // At deploy time every old class is declared, and the upload keeps the one
        // the Worker has while it still holds objects (see `Migration.ts`). At
        // runtime only a class the upload kept has a binding: declaring another
        // would fail.
        const kept = globalThis.__ALCHEMY_RUNTIME__
          ? legacy.filter(({ binding }) => shared.env?.[binding] !== undefined)
          : legacy;
        const mover = kept[0];
        if (mover === undefined) return routeView(shared.namespace, route);
        shared.movers.set(route, mover.binding);
        for (const old of kept)
          yield* declare(
            old.binding,
            old.binding === old.className ? {} : { className: old.className },
            legacyObject(shared, route, impl),
          );
        return routeView(shared.namespace, route);
      }),
    /** The model's class, unscoped: see `Resolver.namespace`. */
    namespace: shared.namespace,
    /** Every route this code hosts in the model's class. */
    routes: (): ReadonlyArray<string> => [...shared.routes.keys()],
    /** A route's objects, if this code hosts it. */
    bound: (route: string): Namespace | undefined =>
      shared.routes.has(route) ? routeView(shared.namespace, route) : undefined,
  };
});
