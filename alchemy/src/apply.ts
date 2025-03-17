import { defaultStage, defaultStateStore } from "./global";
import { type Output, OutputChain, type Resolved } from "./output";
import {
  Input,
  Provider,
  type Resource,
  ResourceID,
  isResource,
} from "./resource";
import { type Scope as IScope, getScope } from "./scope";
import type { StateStore } from "./state";

export interface ApplyOptions {
  stage: string;
  scope: IScope;
  stateStore: StateStore;
  quiet?: boolean;
}

/**
 * Apply a sub-graph to produce a resource.
 * @param output A sub-graph that produces a resource.
 * @returns The resource properties.
 */
export async function apply<T>(
  output: T,
  options?: Partial<ApplyOptions>,
): Promise<Resolved<T>> {
  const stage = options?.stage ?? defaultStage;
  const scope = options?.scope ?? getScope();
  const statePath = scope.getScopePath(stage);
  const stateStore = options?.stateStore ?? new defaultStateStore(statePath);

  return (
    await evaluate(output, { stage, scope, stateStore, quiet: options?.quiet })
  ).value as Resolved<T>;
}

class Evaluated<T> {
  constructor(
    public readonly value: T,
    public readonly deps: string[] = [],
  ) {}
}

const cache = new WeakMap<Resource, Promise<Evaluated<any>>>();

export async function evaluate<T>(
  output: T | Output<T>,
  options: ApplyOptions,
): Promise<Evaluated<T>> {
  const stage = options.stage;
  const stateStore = options.stateStore;
  if (isResource(output)) {
    const resource = output;
    const resourceID = resource[ResourceID];
    const evaluated = await Promise.all(
      resource[Input].map((r) => evaluate<any>(r, options)),
    );

    if (cache.has(resource)) {
      return await cache.get(resource)!;
    }
    let resolve: (value: Evaluated<any>) => void;
    let reject: (reason?: any) => void;
    const promise = new Promise<Evaluated<any>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // set this eagerly to avoid double-apply (caused by recursive applies to inputs)
    cache.set(resource, promise);

    const deps = new Set(evaluated.flatMap((input) => input.deps));
    const inputs = evaluated.map((input) => input.value);
    try {
      const result: T = await resource[Provider].update(
        stage,
        resource,
        deps,
        inputs as [],
        stateStore,
        options,
      );
      resolve!(new Evaluated(result, [resourceID, ...deps]));
    } catch (error) {
      // console.error(error);
      reject!(error);
    }
    return promise;
  } else if (output instanceof OutputChain) {
    const inside = output as unknown as {
      parent: Output<any>;
      fn: (value: any) => T;
    };
    const parent = await evaluate(inside.parent, options);
    const ret = inside.fn(parent.value);
    // the ret may be an Output (e.g. in the flatMap case), so we need to evaluate it and include its deps
    const evaluated = await evaluate(ret, options);
    return new Evaluated<T>(evaluated.value, [
      ...parent.deps,
      ...evaluated.deps,
    ]);
  } else if (Array.isArray(output)) {
    const evaluatedItems = await Promise.all(
      output.map((item) => evaluate(item, options)),
    );
    return new Evaluated(
      evaluatedItems.map((e) => e.value) as unknown as T,
      evaluatedItems.flatMap((e) => e.deps),
    );
  } else if (output instanceof Date) {
    return new Evaluated(output as T);
  } else if (output && typeof output === "object") {
    const entries = Object.entries(output);
    const evaluatedEntries = await Promise.all(
      entries.map(
        async ([key, value]) => [key, await evaluate(value, options)] as const,
      ),
    );

    const result = Object.fromEntries(
      evaluatedEntries.map(([key, evaluated]) => [key, evaluated.value]),
    ) as unknown as T;

    const deps = evaluatedEntries.flatMap(([_, evaluated]) => evaluated.deps);

    return new Evaluated(result, deps);
  }

  // Base case: primitive value
  return new Evaluated<T>(output as T);
}
