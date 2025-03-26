import { apply } from "./apply";
import type { Context } from "./context";
import { Scope as IScope } from "./scope";

export const PROVIDERS = new Map<ResourceKind, Provider<string, any>>();

export type ResourceID = string;
export type ResourceFQN = string;
export type ResourceKind = string;

export interface ProviderOptions {
  /**
   * If true, the resource will be updated even if the inputs have not changed.
   */
  alwaysUpdate: boolean;
}

export type ResourceProps = {
  [key: string]: any;
};

export type Provider<
  Type extends string = string,
  F extends ResourceLifecycleHandler = ResourceLifecycleHandler,
> = F &
  IsClass & {
    type: Type;
    options: Partial<ProviderOptions> | undefined;
    handler: F;
  };

export type PendingResource<
  Out = unknown,
  Kind extends ResourceKind = ResourceKind,
  ID extends ResourceID = ResourceID,
  Scope extends IScope = IScope,
> = Promise<Out> & {
  Kind: Kind;
  ID: ID;
  Scope: Scope;
  signal: () => void;
};

export interface Resource<
  // give each name types for syntax highlighting (differentiation)
  Kind extends string = string,
  ID extends string = string,
  Scope extends IScope = IScope,
> {
  // use capital letters to avoid collision with conventional camelCase typescript properties
  Kind: Kind;
  ID: ID;
  Scope: Scope;
}

// helper for semantic syntax highlighting (color as a type/class instead of function/value)
type IsClass = {
  new (_: never): never;
};

type ResourceLifecycleHandler = (
  this: Context<any>,
  id: string,
  props: any,
) => Promise<Resource<string>>;

// see: https://x.com/samgoodwin89/status/1904640134097887653
type Handler<F extends (...args: any[]) => any> =
  | F
  | (((this: any, id: string, props: Parameters<F>[1]) => never) & IsClass);

export function Resource<
  const Type extends string,
  F extends ResourceLifecycleHandler,
>(type: Type, fn: F): Handler<F>;

export function Resource<
  const Type extends string,
  F extends ResourceLifecycleHandler,
>(type: Type, options: Partial<ProviderOptions>, fn: F): Handler<F>;

export function Resource<
  const Type extends ResourceKind,
  F extends ResourceLifecycleHandler,
>(type: Type, ...args: [Partial<ProviderOptions>, F] | [F]): Handler<F> {
  if (PROVIDERS.has(type)) {
    throw new Error(`Resource ${type} already exists`);
  }
  const [options, handler] = args.length === 2 ? args : [undefined, args[0]];

  type Out = Awaited<ReturnType<F>>;

  const provider = ((
    resourceID: string,
    props: ResourceProps,
  ): Promise<Resource<string>> => {
    const scope = IScope.current;

    if (scope.resources.has(resourceID)) {
      // TODO(sam): do we want to throw?
      // it's kind of awesome that you can re-create a resource and call apply
      // console.warn(`Resource ${id} already exists in the stack: ${stack.id}`);
    }

    // use a lazy promise to defer execution until a signal is received
    let _signal: () => void;
    const signal = new Promise<void>((resolve) => (_signal = resolve));

    const resource = new Promise<Out>((resolve, reject) => {
      signal.then(() =>
        apply(resource, props, options)
          .then((value) => resolve!(value!))
          .catch(reject),
      );
    }) as PendingResource<Out>;
    resource.ID = resourceID;
    resource.signal = _signal!;
    // TODO: trigger the signal on the first then
    // resource.then = (onfulfilled, onrejected) => {
    scope.resources.set(resourceID, resource);
    return resource;
  }) as Provider<Type, F>;
  provider.type = type;
  provider.handler = handler;
  provider.options = options;
  PROVIDERS.set(type, provider);
  return provider;
}
