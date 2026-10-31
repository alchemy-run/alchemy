/**
 * Pluggable ingress for `alchemy dev`.
 *
 * A local resource listens on `http://localhost:<port>`. A dev router
 * (Portless, a tunnel, a corporate proxy, …) can give it a stable name
 * instead. `dev.ingress` on a resource names the router, and the resource's
 * `url` becomes the router's public origin while its raw listener stays the
 * address everything inside the dev session dials.
 *
 * The prop value is an {@link IngressConfig}: plain data
 * (`{ type: "portless", options? }`), because it crosses the `alchemy dev`
 * sidecar's RPC boundary (a function there becomes `null`) and persists in
 * state. The router's package contributes the {@link IngressAdapter} behind
 * the `type` through {@link Contributions.Contributions.ingress}, and the
 * resource's local provider resolves it inside the sidecar with
 * {@link origin} and {@link route}. Core and the resources never import a
 * router package.
 *
 * Both calls build the adapter from its {@link IngressFactory} on every
 * call, so a factory's `make` stays cheap and anything shared between calls
 * (a routes file, a proxy handle) lives outside the adapter value.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import type * as Scope from "effect/Scope";
import * as Contributions from "../Contributions.ts";
import { ResourceContext } from "../ResourceContext.ts";
import { Stack } from "../Stack.ts";
import { UserFacingError } from "../UserFacingError.ts";
import type { PlatformServices } from "../Util/PlatformServices.ts";

/**
 * Which ingress adapter routes a resource's dev URL. The value of
 * `dev.ingress`, returned by a router package's constructor (for example
 * `Portless.Ingress()`).
 */
export interface IngressConfig<Type extends string = string> {
  /**
   * The adapter to resolve, by the name its package contributes with
   * `Contributions.ingress` (for example `"portless"`).
   */
  readonly type: Type;
  /**
   * Adapter-specific options, for example `{ domain: "myapp" }`. Plain JSON
   * data: values that are Outputs are resolved before the local provider
   * sees them.
   */
  readonly options?: IngressOptions | undefined;
}

/** The options of an {@link IngressConfig}, handed to {@link IngressFactory.make}. */
export type IngressOptions = { readonly [key: string]: unknown };

/**
 * The resource an adapter names a route for. The resource's local provider
 * derives it (see {@link createTarget}); users never supply one.
 */
export interface IngressTarget {
  /** The stack's name. */
  readonly stack: string;
  /**
   * The stage as the CLI names it, for example `dev_alice`. Not host-safe
   * (`_` is not a host label): an adapter that builds hostnames slugifies it.
   */
  readonly stage: string;
  /**
   * The resource's fully-qualified name, unique within the stack. Key
   * anything an adapter keeps across restarts by this, never by `id`, which
   * two resources in different namespaces can share.
   */
  readonly fqn: string;
  /** The resource's logical id within its namespace. */
  readonly id: string;
  /**
   * What the route is called, for hostnames and logs. The logical id for most
   * resources; a composite names it after the site it builds, because the
   * server inside it is always `"Build"`.
   */
  readonly label: string;
  /** The resource's type, for example `Cloudflare.Worker`. */
  readonly type: string;
}

/**
 * A router, as `alchemy dev` uses it. Every method fails with
 * {@link IngressError}.
 */
export interface IngressAdapter {
  /**
   * Where `target` answers. A function of the target and the adapter's
   * options only: it needs no listener, and it returns what {@link attach}
   * returns for the same target. A caller that needs the address before the
   * listener exists (a cycle's pre-create, a Worker binding to its own URL)
   * asks here.
   */
  readonly origin: (target: IngressTarget) => Effect.Effect<string, IngressError>;
  /**
   * Route the target's {@link origin} to `listener` and return the origin.
   * The route lasts until the `Scope` closes. Fail when the route can't be
   * made, so the resource never advertises an origin that isn't routed.
   *
   * - Attaching the same `fqn` and `listener` again changes nothing.
   * - Attaching an `fqn` to a new listener replaces its route.
   * - Closing the `Scope` removes the route this call added, unless a later
   *   attach for the same `fqn` took it over. It removes nothing else.
   */
  readonly attach: (
    target: IngressTarget,
    listener: URL,
  ) => Effect.Effect<string, IngressError, Scope.Scope>;
}

/**
 * Builds an {@link IngressAdapter} from an {@link IngressConfig}'s options.
 * A router package contributes one per `type` with
 * {@link Contributions.Contributions.ingress}.
 */
export interface IngressFactory {
  readonly make: (
    options: IngressOptions | undefined,
  ) => Effect.Effect<IngressAdapter, IngressError, IngressServices>;
}

/**
 * The services an adapter runs under: the host's platform services and HTTP
 * client, which the dev sidecar provides to every local provider.
 */
export type IngressServices = PlatformServices | HttpClient;

/**
 * Adapter factories by {@link IngressConfig.type}, resolved before the
 * packages that contribute them. For tests and in-process runs, which have
 * no sidecar to load a contributed adapter into.
 *
 * ```ts
 * Layer.succeed(Ingress.Adapters, { test: myFactory })
 * ```
 */
export class Adapters extends Context.Service<Adapters, Readonly<Record<string, IngressFactory>>>()(
  "alchemy/Local/Ingress/Adapters",
) {}

/** An adapter could not make or remove a route. */
export class IngressError extends Data.TaggedError("IngressError")<{
  /** The adapter's {@link IngressConfig.type}. */
  readonly type: string;
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly [UserFacingError] = true;
}

/**
 * A resource selected an ingress adapter that can't be resolved: no installed
 * package contributes it, or the package that does failed to load. Raised
 * instead of advertising a URL nothing routes.
 */
export class IngressAdapterNotFound extends Data.TaggedError("IngressAdapterNotFound")<{
  /** The {@link IngressConfig.type} that didn't resolve. */
  readonly type: string;
  /** Why it didn't, from {@link Contributions.ingress}. */
  readonly reason: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return (
      `Ingress adapter "${this.type}" could not be resolved: ${this.reason}. ` +
      `Install the package that provides it (@alchemy.run/${this.type} for first-party adapters) ` +
      `in the project that runs alchemy dev.`
    );
  }
}

/**
 * The {@link IngressTarget} of the resource whose lifecycle operation is
 * running, from the ambient `Stack` and `ResourceContext`. `label` defaults
 * to the resource's logical id.
 */
export const createTarget = Effect.fn("Ingress.createTarget")(function* (
  options: { readonly label?: string } = {},
) {
  const stack = yield* Stack;
  const resource = yield* ResourceContext;
  return {
    stack: stack.name,
    stage: stack.stage,
    fqn: resource.fqn,
    id: resource.logicalId,
    label: options.label ?? resource.logicalId,
    type: resource.type,
  } satisfies IngressTarget;
});

/** The factory for `type`: an {@link Adapters} entry first, then a contributed one. */
const factoryFor = Effect.fn("Ingress.factoryFor")(function* (type: string) {
  const override = yield* Effect.serviceOption(Adapters);
  if (override._tag === "Some" && Object.hasOwn(override.value, type)) {
    return override.value[type]!;
  }
  return yield* Contributions.ingress(type).pipe(
    Effect.mapError((error) => new IngressAdapterNotFound({ type, reason: error.message })),
  );
});

const adapterFor = Effect.fn("Ingress.adapterFor")(function* (config: IngressConfig) {
  const factory = yield* factoryFor(config.type);
  return yield* factory.make(config.options);
});

/**
 * Where `target` answers under `config`'s adapter, before any listener
 * exists. Fails with {@link IngressAdapterNotFound} when the adapter can't be
 * resolved.
 */
export const origin = Effect.fn("Ingress.origin")(function* (
  config: IngressConfig,
  target: IngressTarget,
) {
  const adapter = yield* adapterFor(config);
  return yield* adapter.origin(target);
});

/**
 * Route `target`'s origin to `listener` until the `Scope` closes, and return
 * the origin. Fails with {@link IngressAdapterNotFound} when the adapter can't
 * be resolved and with {@link IngressError} when it can't route, so the caller
 * never advertises an unrouted URL.
 */
export const route = Effect.fn("Ingress.route")(function* (
  config: IngressConfig,
  target: IngressTarget,
  listener: URL,
) {
  const adapter = yield* adapterFor(config);
  return yield* adapter.attach(target, listener);
});
