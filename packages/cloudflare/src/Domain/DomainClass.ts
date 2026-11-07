import type * as Backfill from "@alchemy.run/domain/Backfill";
import type { Delivery } from "@alchemy.run/domain/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import {
  DurableObject as CloudflareDurableObject,
  type DurableObjectJurisdiction,
} from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { type Worker, Worker as CloudflareWorker } from "../Workers/Worker.ts";
import { WorkerEnvironment } from "../Workers/WorkerRuntime.ts";
import { Workflow, type WorkflowImpl } from "../Workflows/Workflow.ts";
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

export interface Stub {
  readonly [method: string]: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
}

export interface Namespace {
  readonly getByName: (name: string) => any;
  readonly jurisdiction: (jurisdiction: DurableObjectJurisdiction) => Namespace;
}

/** What an instance's methods and constructor run with. */
type InstanceServices = DurableObjectState | RuntimeContext | Scope.Scope;

export type ObjectImpl = Effect.Effect<
  Effect.Effect<Record<string, unknown>, never, InstanceServices>,
  never,
  DurableObjectState
>;

export const declare = CloudflareDurableObject as unknown as (
  name: string,
  impl: ObjectImpl,
) => Effect.Effect<Namespace, never, Worker>;

/** Declare the class `className` with `impl`, bound as `binding`. */
export const declareAs = (binding: string, className: string, impl: ObjectImpl) => {
  if (binding === className) return declare(binding, impl);
  const Class = (
    CloudflareDurableObject as unknown as () => (
      name: string,
      props: { readonly className: string },
    ) => Effect.Effect<Namespace> & {
      readonly make: (impl: ObjectImpl) => Layer.Layer<never, never, Worker>;
    }
  )()(binding, { className });
  return Effect.provide(Class, Class.make(impl)) as Effect.Effect<Namespace, never, Worker>;
};

/** A class an object's data may still be on: its name, and the binding the code reaches it by. */
export interface LegacyClass {
  readonly binding: string;
  readonly className: string;
}

/** The objects of one route, in the shared class. */
export const routeView = (namespace: Namespace, route: string): Namespace => ({
  getByName: (key: string) => namespace.getByName(`${route}/${key}`),
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
 * every aggregate and view (and, from this release on, every other object),
 * and each one's history names the consumer objects it reached.
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
  /** The name of a source instance's scanner in a consumer's run (see `Domain/index.ts`). */
  readonly scanner: (ref: Backfill.SourceRef) => string;
}

/** What makes job tokens: the platform's secure random source. */
export interface Random {
  readonly uuidV4: () => Effect.Effect<string>;
}

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
    routes.set(MIGRATION_ROUTE, migrationObject(classes));
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
    /** Each hosted route's version 0 class. */
    movers: shared.movers,
    /**
     * Host `route`'s objects in the shared class. `legacy` are the classes
     * they may still be on: their version 0 class, and their class from
     * before versions. Each is declared too, running the same code, so a
     * Worker upgraded from either moves their storage over.
     */
    object: (route: string, impl: ObjectImpl, legacy: ReadonlyArray<LegacyClass> = []) =>
      Effect.gen(function* () {
        shared.routes.set(route, impl);
        if (shared.movers.has(route)) return routeView(shared.namespace, route);
        // At deploy time every candidate class is declared, and the upload keeps
        // those still holding objects (see `Version.keptMovers`). At runtime only
        // those the upload kept have a binding: declaring another would fail.
        for (const { binding, className } of legacy) {
          if (globalThis.__ALCHEMY_RUNTIME__ && shared.env?.[binding] === undefined) continue;
          if (!shared.movers.has(route)) shared.movers.set(route, binding);
          yield* declareAs(binding, className, legacyObject(shared, route, impl));
        }
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
