/**
 * Pluggable ingress for `alchemy dev`.
 *
 * A local resource listens on `http://localhost:<port>`. A dev router
 * (Portless, a tunnel, a corporate proxy, …) can give it a stable name
 * instead. `dev.ingress` on a resource names the module that routes it, and
 * the resource's `url` becomes the router's public origin while its raw
 * listener stays the address everything inside the dev session dials.
 *
 * The prop value is an {@link Ingress}: plain data naming a module whose
 * default export is a {@link Router} Layer. It is data because it crosses the
 * `alchemy dev` sidecar's RPC boundary (a function there becomes `null`) and
 * persists in state, and so nothing of the router is bundled into the
 * resource. The resource's local provider calls {@link attach} inside the
 * sidecar, which imports the module and builds its Layer once per process.
 * Core and the resources never import a router package.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Scope from "effect/Scope";
import { UserFacingError } from "../UserFacingError.ts";
import { resolveFromProject } from "../Util/internal/PackageResolve.ts";

/**
 * A resource's `dev.ingress`: which module routes its dev URL. A router
 * package's constructor returns one (for example `Portless.Ingress(proxy)`),
 * adding whatever settings its {@link Router} reads. Every field is plain
 * data.
 */
export interface Ingress {
  /**
   * Package specifier of the module whose default export is a
   * {@link Router} Layer, for example `"@alchemy.run/portless/IngressLive"`.
   * Resolved from the project `alchemy dev` runs in, so the router's package
   * is a dependency of the project, not of alchemy.
   */
  readonly module: string;
  /**
   * What the route is called, for hostnames and logs. The router decides
   * what to do without one; routers in alchemy use the resource's logical id.
   */
  readonly name?: string | undefined;
}

/** The resource being routed. Its local provider builds it; users never do. */
export interface Target {
  /** The stack's name. */
  readonly stack: string;
  /**
   * The stage as the CLI names it, for example `dev_alice`. Not host-safe
   * (`_` is not a host label): a router that builds hostnames slugifies it.
   */
  readonly stage: string;
  /**
   * The resource's fully-qualified name, unique within the stack. Key
   * anything a router keeps across restarts by this, never by `id`, which
   * two resources in different namespaces can share.
   */
  readonly fqn: string;
  /** The resource's logical id within its namespace. */
  readonly id: string;
  /** The resource's type, for example `Cloudflare.Worker`. */
  readonly type: string;
}

/** A router could not be loaded, or could not make or remove a route. */
export class IngressError extends Data.TaggedError("IngressError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly [UserFacingError] = true;
}

/**
 * What an ingress module's default-export Layer provides.
 *
 * `attach` routes `target` to `listener` and returns the origin it answers
 * at. The route lasts until the `Scope` closes. It fails when the route
 * can't be made, so the resource never advertises an origin that isn't
 * routed.
 *
 * - Attaching the same `fqn` and `listener` again changes nothing.
 * - Attaching an `fqn` to a new listener replaces its route.
 * - Closing the `Scope` removes the route this call added, unless a later
 *   attach for the same `fqn` took it over. It removes nothing else.
 */
export class Router extends Context.Service<
  Router,
  {
    readonly attach: (
      ingress: Ingress,
      target: Target,
      listener: URL,
    ) => Effect.Effect<string, IngressError, Scope.Scope>;
  }
>()("alchemy/Local/Ingress/Router") {}

/**
 * The services a router's Layer is built with: the ones the dev sidecar
 * provides to every local provider, so a provider that calls {@link attach}
 * asks `providers()` for nothing new.
 */
type Services = ChildProcessSpawner | FileSystem | Path | HttpClient;

/** Each module's Router, built once and kept for the life of the process. */
const routers = new Map<string, Deferred.Deferred<Router["Service"], IngressError>>();

const routerFor = Effect.fnUntraced(function* (module: string) {
  const known = routers.get(module);
  if (known !== undefined) return yield* Deferred.await(known);
  const deferred = Deferred.makeUnsafe<Router["Service"], IngressError>();
  routers.set(module, deferred);
  const fail = (message: string) => (cause?: unknown) =>
    new IngressError({ message: `Ingress module ${module} ${message}`, cause });
  const project = yield* Effect.sync(() => process.cwd());
  const exit = yield* resolveFromProject(module, project).pipe(
    Effect.mapError(fail("could not be resolved")),
    Effect.flatMap((url) =>
      url === undefined
        ? Effect.fail(fail(`is not installed in ${project}`)())
        : Effect.tryPromise({
            try: (): Promise<{ readonly default?: unknown }> => import(url),
            catch: fail("could not be imported"),
          }),
    ),
    Effect.flatMap((loaded) =>
      Layer.isLayer(loaded.default)
        ? // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- dynamically imported ingress module; Router is checked after the build
          Effect.succeed(loaded.default as Layer.Layer<Router, unknown, Services>)
        : Effect.fail(fail("has no default-export Layer")()),
    ),
    Effect.flatMap((layer) =>
      Layer.buildWithScope(layer, Scope.makeUnsafe()).pipe(
        Effect.mapError(fail("failed to build")),
      ),
    ),
    Effect.flatMap((context) => {
      const router = Context.getOption(context, Router);
      return router._tag === "Some"
        ? Effect.succeed(router.value)
        : Effect.fail(fail("provides no Router")());
    }),
    Effect.exit,
  );
  // A failure is not kept: the next attach tries again.
  if (exit._tag === "Failure") routers.delete(module);
  yield* Deferred.done(deferred, exit);
  return yield* exit;
});

/**
 * Route `target` to `listener` through the router `ingress.module` provides,
 * until the `Scope` closes, and return the origin it answers at. Fails with
 * {@link IngressError} when the module can't be loaded or can't route, so
 * the caller never advertises an unrouted URL.
 *
 * ```ts
 * const url = ingress
 *   ? yield* Ingress.attach(ingress, { stack: stack.name, stage: stack.stage, fqn, id, type }, listener)
 *   : listener.href;
 * ```
 */
export const attach = Effect.fn("Ingress.attach")(function* (
  ingress: Ingress,
  target: Target,
  listener: URL,
) {
  const router = yield* routerFor(ingress.module);
  return yield* router.attach(ingress, target, listener);
});
