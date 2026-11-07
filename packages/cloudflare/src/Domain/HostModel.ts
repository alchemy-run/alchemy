import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Worker as CloudflareWorker } from "../Workers/Worker.ts";
import { WorkerEnvironment } from "../Workers/WorkerRuntime.ts";
import { Workflow, type WorkflowImpl } from "../Workflows/Workflow.ts";
import { legacyObject } from "./LegacyObject.ts";
import { MIGRATION_ROUTE, migration, migrationObject } from "./MigrationRun.ts";
import {
  type Classes,
  type LegacyClass,
  type Namespace,
  type ObjectImpl,
  type Random,
  type Resolver,
  declare,
  declareAs,
  domainClassName,
  routeView,
} from "./ModelClass.ts";
import { router } from "./Router.ts";
import { MIGRATION_WORKFLOW } from "./Version.ts";

/**
 * Domain version 1 hosts every object of a model in one Durable Object class,
 * named after the model: `Billing.Domain`. An object's name is its route and
 * key, `Billing.AccountAggregate/a-1`: the route names the definition, as each
 * class did in version 0. Each model has its own class, so removing a model
 * from a Worker deletes its class, and a Worker declares one class per model
 * however many definitions it has.
 *
 * A Worker upgraded from version 0 keeps each old class live, running the same
 * code, until its objects have moved (see `DurableObjectMove.ts`). Callers
 * always address the new object. Until it owns its key's data, it forwards
 * every call to the old object, which keeps serving, while it copies the old
 * object's storage in the background; then it seals the old object and takes
 * over in one short step. The first call to a key starts its move; a deploy's
 * {@link MIGRATION_WORKFLOW} moves the rest. See `Version.ts` for when the old
 * classes are deleted.
 */

/** Each model's class, per Worker. */
const workers = new WeakMap<object, Map<string, Classes>>();

/** The migration Workflow of each Worker: one moves every model's objects. */
const migrationWorkflows = new WeakMap<object, { readonly workflowName: unknown }>();

/** The class of `modelName` on the host Worker, declared on first use. */
export const hostModel = Effect.fn(function* (random: Random, modelName: string) {
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
