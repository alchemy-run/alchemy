import { apply } from "./apply.js";
import { type Context, context } from "./context.js";
import { Scope as _Scope, type Scope } from "./scope.js";

export const PROVIDERS = new Map<ResourceKind, Provider<string, any>>();
export const WILDCARD_DELETION_HANDLERS = new Map<
  string,
  WildcardDeletionHandler
>();

export type ResourceID = string;
export const ResourceID = Symbol.for("alchemy::ResourceID");
export type ResourceFQN = string;
export const ResourceFQN = Symbol.for("alchemy::ResourceFQN");
export type ResourceKind = string;
export const ResourceKind = Symbol.for("alchemy::ResourceKind");
export const ResourceScope = Symbol.for("alchemy::ResourceScope");
export const InnerResourceScope = Symbol.for("alchemy::InnerResourceScope");
export const ResourceSeq = Symbol.for("alchemy::ResourceSeq");

/**
 * Handler function for wildcard deletion patterns
 */
export type WildcardDeletionHandler = (
  this: Context<any>,
  pattern: string,
  options?: { quiet?: boolean },
) => Promise<void>;

/**
 * Register a wildcard deletion handler for a given pattern
 * @param pattern The wildcard pattern to match (e.g. "AWS::*")
 * @param handler The handler function to call for matching resources
 */
export function registerDeletionHandler(
  pattern: string,
  handler: WildcardDeletionHandler,
): void {
  if (WILDCARD_DELETION_HANDLERS.has(pattern)) {
    throw new Error(
      `Wildcard deletion handler for pattern '${pattern}' already registered`,
    );
  }
  WILDCARD_DELETION_HANDLERS.set(pattern, handler);
}

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

// see: https://x.com/samgoodwin89/status/1904640134097887653
type Handler<F extends (...args: any[]) => any> =
  | F
  | (((this: any, id: string, props?: {}) => never) & IsClass);

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

  const provider = (async (
    resourceID: string,
    props: ResourceProps,
  ): Promise<Resource<string>> => {
    const scope = _Scope.current;

    // Handle wildcard deletion pattern
    if (scope.stage === "destroy") {
      // Check for AWS::* pattern or explicit wildcard in the type
      const isWildcardType = type.includes("*");
      const isWildcardId = resourceID.includes("*");

      if (isWildcardType || isWildcardId) {
        // First check registered handlers
        for (const [pattern, handler] of WILDCARD_DELETION_HANDLERS.entries()) {
          if (
            type.startsWith(pattern.replace("*", "")) ||
            resourceID.startsWith(pattern.replace("*", ""))
          ) {
            const ctx = context({
              scope,
              phase: "delete",
              kind: type,
              id: resourceID,
              fqn: scope.fqn(resourceID),
              seq: scope.seq(),
              props: props,
              state: undefined as any,
              replace: () => {
                throw new Error(
                  "Cannot replace a resource during wildcard deletion. " +
                    "The wildcardDelete handler should handle cleanup of matching resources.",
                );
              },
            });
            return handler.call(ctx, resourceID, { quiet: scope.quiet }) as any;
          }
        }

        throw new Error(
          `No wildcard deletion handler registered for pattern '${isWildcardType ? type : resourceID}'. ` +
            "To handle wildcard deletions, register a handler using registerDeletionHandler(). " +
            `This is required for resource type '${type}' to support cleanup of multiple resources.`,
        );
      }
    }

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
        throw new Error(
          `Resource ${resourceID} already exists in the stack and is of a different type: '${otherResource?.[ResourceKind]}' !== '${type}'`,
        );
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
  }) as Provider<Type, F>;
  provider.type = type;
  provider.handler = handler;
  provider.options = options;
  PROVIDERS.set(type, provider);
  return provider;
}
