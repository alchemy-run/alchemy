import type * as Backfill from "@alchemy.run/domain/Backfill";
import type { Delivery } from "@alchemy.run/domain/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import {
  DurableObject as CloudflareDurableObject,
  type DurableObjectJurisdiction,
} from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { type Worker } from "../Workers/Worker.ts";

/**
 * A Domain model's Durable Object class, `Billing.Domain`, and what its parts
 * share: object names (`route/key`), the stubs and namespaces they call, the
 * class registry a Worker keeps per model, and how a class is declared.
 */

export const domainClassName = (modelName: string) =>
  `${modelName}.Domain`.replace(/[^A-Za-z0-9_.]/g, "_");

/** The key an object listed itself under in the backfill directory. */
export const ID_KEY = "bf:id";

/** What an old object's storage answers once its data has moved (`DurableObjectMove`). */
export const MOVED = "data has moved to another object";

/** What a sealed old object answers a forwarded call: the new object takes over and serves. */
export const SEALED = "domain object sealed: its data moved to the new object";

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

/** A move of an old object's storage that didn't complete; the move is tried again. */
export class DomainMoveFailed extends Data.TaggedError("DomainMoveFailed")<{
  readonly message: string;
}> {}

export const failed = (what: string) => (cause: unknown) =>
  new DomainMoveFailed({
    message: `${what}: ${
      typeof cause === "object" && cause !== null && "message" in cause
        ? String(cause.message)
        : String(cause)
    }`,
  });

/** The objects of one route, in the shared class. */
export const routeView = (namespace: Namespace, route: string): Namespace => ({
  getByName: (key: string) => namespace.getByName(`${route}/${key}`),
  jurisdiction: (jurisdiction) => routeView(namespace.jurisdiction(jurisdiction), route),
});

/** An object's route and key, from its name. */
export const parseName = (name: string | undefined) => {
  const slash = name === undefined ? -1 : name.indexOf("/");
  return slash < 0 ? undefined : { route: name!.slice(0, slash), key: name!.slice(slash + 1) };
};

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

export const orDie = <A>(effect: Effect.Effect<unknown, unknown>) =>
  effect.pipe(Effect.orDie) as Effect.Effect<A>;
