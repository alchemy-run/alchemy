import { isPromise } from "node:util/types";
import type { Binding as CloudflareBinding } from "../cloudflare/bindings.ts";
import type { Bound as CloudflareBound } from "../cloudflare/bound.ts";
import { isWorkerStub } from "../cloudflare/worker-stub.ts";
import { isWorker } from "../cloudflare/worker.ts";
import { env } from "../env.ts";
import { ResourceFQN, ResourceScope, type Resource } from "../resource.ts";
import { isRuntime } from "./global.ts";

/**
 * Get a Resource's Binding from the Environment.
 */
export function getBinding<T extends Resource>(resource: T): Bound<T> {
  return env[getBindKey(resource)] as Bound<T>;
}

export function tryGetBinding<T extends Resource>(
  resource: T,
): Promise<Bound<T>> | undefined {
  if (isRuntime) {
    return getBinding(resource);
  }
  return undefined;
}

/**
 * Compute a unique key for where to store a Resource's Binding.
 */
export function getBindKey(resource: Resource): string {
  if (isWorker(resource) || isWorkerStub(resource)) {
    return `worker:${resource.name}`;
  }
  const fqn = resource[ResourceFQN];
  const scope = resource[ResourceScope];
  const prefix = `${scope.appName}/${scope.stage}`;
  const key = fqn.slice(prefix.length + 1).replace(/[^a-zA-Z0-9-_]/g, "_");
  return key;
}

export type Bound<T> = T extends CloudflareBinding ? CloudflareBound<T> : T;

/**
 * Create a lazy binding of a Resource to an environment that exposes the Resource's methods
 * throw a Proxy that delays initialization of the binding until the Resource's methods are accessed.
 *
 * This allows us to run the same code during build time and runtime.
 */
export async function bind<T extends Resource>(
  resource: T | Promise<T>,
  options?: {
    reify?: (value: T, key: string) => Promise<Bound<T>>;
    /** @default true */
    bindThis?: boolean;
  },
): Promise<Bound<T>> {
  if (isPromise(resource)) {
    return resource.then((r) => bind(r, options)) as Promise<Bound<T>>;
  }
  let _runtime: [Bound<T>] | undefined;
  const runtime = async (): Promise<Bound<T>> =>
    (_runtime ??= [
      await (options?.reify
        ? options.reify(resource, getBindKey(resource))
        : getBinding(resource)),
    ])[0];

  return new Proxy(() => {}, {
    get: (target: any, prop: string) => {
      if (prop in target) {
        return (resource as T)[prop as keyof T];
      } else if (prop === "then" || prop === "catch" || prop === "finally") {
        return target[prop];
      }
      return async (...args: any[]) => {
        const rt: Bound<T> = await runtime();
        if (rt === undefined) {
          throw new Error(`Resource ${resource[ResourceFQN]} is not bound`);
        }
        const method = rt[prop as keyof Bound<T>];
        if (typeof method !== "function") {
          throw new Error(
            `Method ${prop} on '${resource[ResourceFQN]}' is not a function`,
          );
        }
        if (options?.bindThis !== false) {
          return method.bind(rt)(...args);
        }
        return method(...args);
      };
    },
    // apply: (target, thisArg, argArray) => {
    //   return target(thisArg, ...argArray);
    // },
  }) as T & Bound<T>;
}
