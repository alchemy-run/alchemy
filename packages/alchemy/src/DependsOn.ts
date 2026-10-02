import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Extra ordering dependencies for the resources declared inside an Effect,
 * applied with {@link dependsOn}.
 *
 * A dependency here orders a resource after its targets without passing a
 * value between them. It follows the same rules as a reference in props:
 *
 * - `dependsOn(resource)` waits for the resource to finish, including every
 *   eventual attribute its provider declares — a `Kubernetes.Job`'s
 *   completion, a load balancer's address.
 * - `dependsOn(resource.attr)` waits for just that attribute.
 *
 * Dependencies are captured at registration like {@link RemovalPolicy}. They
 * aren't props, so adding or removing one never changes the resource's diff;
 * the edge is recorded for delete ordering like any other.
 */
export class DependsOn extends Context.Service<DependsOn, readonly unknown[]>()(
  "DependsOn",
) {}

/**
 * Order every resource declared inside the piped Effect after `deps`.
 *
 * Nested `dependsOn` calls accumulate, so it can decorate one resource or a
 * whole scope.
 *
 * @example Run a Deployment after a migration Job completes
 * ```typescript
 * const migrate = yield* Kubernetes.Job("Migrate", {
 *   cluster,
 *   main: import.meta.url,
 * });
 *
 * const web = yield* Kubernetes.Deployment("Web", {
 *   cluster,
 *   image: "ghcr.io/acme/web:1.4.0",
 *   port: 8080,
 * }).pipe(dependsOn(migrate));
 * ```
 *
 * @example Wait for a single attribute
 * ```typescript
 * const record = yield* Cloudflare.DnsRecord("Api", {
 *   zone,
 *   name: "api",
 *   type: "CNAME",
 *   content: "placeholder.example.com",
 * }).pipe(dependsOn(web.url));
 * ```
 *
 * @param deps Resources or resource attributes to wait for.
 */
export const dependsOn =
  (...deps: unknown[]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.serviceOption(DependsOn).pipe(
      Effect.flatMap((outer) =>
        effect.pipe(
          Effect.provideService(DependsOn, [
            ...Option.getOrElse(outer, () => []),
            ...deps,
          ]),
        ),
      ),
    );
