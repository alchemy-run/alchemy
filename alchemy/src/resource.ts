import { apply } from "./apply.ts";
import type { Context, DevContext } from "./context.ts";
import { Scope as _Scope, type Scope } from "./scope.ts";
import { formatFQN } from "./util/cli.ts";
import { logger } from "./util/logger.ts";

export const PROVIDERS: Map<ResourceKind, Provider<string, any>> = new Map<
  ResourceKind,
  Provider<string, any>
>();
const DYNAMIC_RESOURCE_RESOLVERS: DynamicResourceResolver[] = [];

export type DynamicResourceResolver = (
  typeName: string,
) => Provider | undefined;

/**
 * Register a function that will be called if a Resource Type cannot be found during deletion.
 */
export function registerDynamicResource(
  handler: DynamicResourceResolver,
): void {
  DYNAMIC_RESOURCE_RESOLVERS.push(handler);
}

export function resolveDeletionHandler(typeName: string): Provider | undefined {
  const provider: Provider<string, any> | undefined = PROVIDERS.get(typeName);
  if (provider) {
    return provider;
  }
  for (const handler of DYNAMIC_RESOURCE_RESOLVERS) {
    const result = handler(typeName);
    if (result) {
      return result;
    }
  }
  return undefined;
}

export type ResourceID = string;
export const ResourceID = Symbol.for("alchemy::ResourceID");
export type ResourceFQN = string;
export const ResourceFQN = Symbol.for("alchemy::ResourceFQN");
export type ResourceKind = string;
export const ResourceKind = Symbol.for("alchemy::ResourceKind");
export const ResourceScope = Symbol.for("alchemy::ResourceScope");
export const InnerResourceScope = Symbol.for("alchemy::InnerResourceScope");
export const ResourceSeq = Symbol.for("alchemy::ResourceSeq");
export const IsInvalidHandler = Symbol.for("alchemy::IsInvalidHandler");

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
  FL extends LocalResourceLifecycleHandler = LocalResourceLifecycleHandler,
> = (F | FL) &
  IsClass & {
    type: Type;
    options: Partial<ProviderOptions> | undefined;
    getHandler(): F | FL;
    liveHandler: F;
    localHandler: FL;
  };

export interface PendingResource<Out = unknown> extends Promise<Out> {
  [ResourceKind]: ResourceKind;
  [ResourceID]: ResourceID;
  [ResourceFQN]: ResourceFQN;
  [ResourceScope]: Scope;
  [ResourceSeq]: number;
  [InnerResourceScope]: Promise<Scope>;
}

export interface Resource<Kind extends ResourceKind = ResourceKind> {
  [ResourceKind]: Kind;
  [ResourceID]: ResourceID;
  [ResourceFQN]: ResourceFQN;
  [ResourceScope]: Scope;
  [ResourceSeq]: number;
}

// helper for semantic syntax highlighting (color as a type/class instead of function/value)
type IsClass = {
  new (_: never): never;
};

type ResourceLifecycleHandler = (
  this: Context<any, any>,
  id: string,
  props: any,
) => Promise<Resource<string>>;

type LocalResourceLifecycleHandler = (
  this: DevContext<any, any>,
  id: string,
  props: any,
) => Promise<Resource<string>>;

const localModeHandlerUnavailable: LocalResourceLifecycleHandler & {
  [IsInvalidHandler]: true;
} = function (this) {
  logger.error(`Local mode handler unavailable for ${formatFQN(this.fqn)}`);
  throw new Error("Local mode handler unavailable");
};
localModeHandlerUnavailable[IsInvalidHandler] = true;

const liveModeHandlerUnavailable: ResourceLifecycleHandler & {
  [IsInvalidHandler]: true;
} = function (this) {
  logger.error(`Live mode handler unavailable for ${formatFQN(this.fqn)}`);
  throw new Error("Live mode handler unavailable");
};
liveModeHandlerUnavailable[IsInvalidHandler] = true;

function isInvalidHandlerConfig(handler: any): handler is {
  [IsInvalidHandler]: true;
} {
  return IsInvalidHandler in handler;
}

// see: https://x.com/samgoodwin89/status/1904640134097887653
type Handler<F extends (...args: any[]) => any> =
  | F
  | (((this: any, id: string, props?: {}) => never) & IsClass);

export function LiveOnlyResource<
  const Type extends string,
  F extends ResourceLifecycleHandler,
>(type: Type, fn: F): Handler<F>;

export function LiveOnlyResource<
  const Type extends string,
  F extends ResourceLifecycleHandler,
>(type: Type, options: Partial<ProviderOptions>, fn: F): Handler<F>;

export function LiveOnlyResource<
  const Type extends ResourceKind,
  F extends ResourceLifecycleHandler,
>(type: Type, ...args: [Partial<ProviderOptions>, F] | [F]): Handler<F> {
  // this error is actually fine since we know localModeHandlerUnavailable will
  // always throw. This is probably a good argument for why we might want effect
  //@ts-expect-error: see above comment
  return Resource<Type, F, typeof localModeHandlerUnavailable>(
    type,
    //@ts-expect-error
    ...args,
    localModeHandlerUnavailable,
  );
}

export function LocalOnlyResource<
  const Type extends string,
  FL extends LocalResourceLifecycleHandler,
>(type: Type, fn: FL): Handler<FL>;

export function LocalOnlyResource<
  const Type extends string,
  FL extends LocalResourceLifecycleHandler,
>(type: Type, options: Partial<ProviderOptions>, fn: FL): Handler<FL>;

export function LocalOnlyResource<
  const Type extends ResourceKind,
  FL extends LocalResourceLifecycleHandler,
>(type: Type, ...args: [Partial<ProviderOptions>, FL] | [FL]): Handler<FL> {
  const lastArg = args[args.length - 1];
  const allArgsExceptLast = args.slice(0, -1);
  // this error is actually fine since we know localModeHandlerUnavailable will
  // always throw. This is probably a good argument for why we might want effect
  //@ts-expect-error: see above comment
  return Resource<Type, typeof liveModeHandlerUnavailable, FL>(
    type,
    //@ts-expect-error
    ...allArgsExceptLast,
    liveModeHandlerUnavailable,
    lastArg,
  );
}

export function Resource<
  const Type extends string,
  F extends ResourceLifecycleHandler,
  FL extends LocalResourceLifecycleHandler,
>(type: Type, liveHandler: F, localHandler: FL): Handler<F | FL>;

export function Resource<
  const Type extends string,
  F extends ResourceLifecycleHandler,
  FL extends LocalResourceLifecycleHandler,
>(
  type: Type,
  options: Partial<ProviderOptions>,
  liveHandler: F,
  localHandler: FL,
): Handler<F | FL>;

export function Resource<
  const Type extends ResourceKind,
  F extends ResourceLifecycleHandler,
  FL extends LocalResourceLifecycleHandler,
>(
  type: Type,
  ...args:
    | [Partial<ProviderOptions>, F, FL]
    | [F, FL]
    | [Partial<ProviderOptions>, F, FL]
    | [F, FL]
): Handler<F | FL> {
  if (PROVIDERS.has(type)) {
    throw new Error(`Resource ${type} already exists`);
  }
  const [options, liveHandler, localHandler] =
    args.length === 3 ? args : [undefined, args[0], args[1]];

  // TODO(michael): not a fan of dual return types, maybe tag?
  type Out = Awaited<ReturnType<F | FL>>;

  const provider = (async (
    resourceID: string,
    props: ResourceProps,
  ): Promise<Resource<string>> => {
    const scope = _Scope.current;

    if (resourceID.includes(":")) {
      // we want to use : as an internal separator for resources
      throw new Error(`ID cannot include colons: ${resourceID}`);
    }

    if (scope.resources.has(resourceID)) {
      // TODO(sam): do we want to throw?
      // it's kind of awesome that you can re-create a resource and call apply
      const otherResource = scope.resources.get(resourceID);
      if (otherResource?.[ResourceKind] !== type) {
        scope.fail();
        const error = new Error(
          `Resource ${resourceID} already exists in the stack and is of a different type: '${otherResource?.[ResourceKind]}' !== '${type}'`,
        );
        scope.telemetryClient.record({
          event: "resource.error",
          resource: type,
          error,
        });
        throw error;
      }
    }

    // get a sequence number (unique within the scope) for the resource
    const seq = scope.seq();
    let resolveInnerScope: ((scope: Scope) => void) | undefined;
    const meta = {
      [ResourceKind]: type,
      [ResourceID]: resourceID,
      [ResourceFQN]: scope.fqn(resourceID),
      [ResourceSeq]: seq,
      [ResourceScope]: scope,
      [InnerResourceScope]: new Promise<Scope>((resolve) => {
        resolveInnerScope = resolve;
      }),
    } as any as PendingResource<Out>;
    const promise = apply(meta, props, {
      ...options,
      resolveInnerScope,
    });
    const resource = Object.assign(promise, meta);
    scope.resources.set(resourceID, resource);
    return resource;
  }) as Provider<Type, F, FL>;
  provider.type = type;
  provider.liveHandler = liveHandler;
  provider.localHandler = localHandler;
  provider.getHandler = () => {
    const scope = _Scope.current;
    switch (scope.mode) {
      case "dev":
        return provider.localHandler;
      case "live":
        return provider.liveHandler;
      case "hybrid-prefer-dev":
        return isInvalidHandlerConfig(provider.localHandler)
          ? provider.liveHandler
          : provider.localHandler;
      case "hybrid-prefer-live":
        return isInvalidHandlerConfig(provider.liveHandler)
          ? provider.localHandler
          : provider.liveHandler;
    }
  };
  provider.options = options;
  PROVIDERS.set(type, provider);
  return provider;
}
