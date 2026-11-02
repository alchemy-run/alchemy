import * as Effect from "effect/Effect";
import * as StackitBindings from "../StackitBindings.ts";
import type { BindingScope } from "./BindingScope.ts";
import type { LoadBalancer } from "./LoadBalancer.ts";
import type { ObservabilityCredential } from "./ObservabilityCredential.ts";

/**
 * Shared HTTP scaffolding for Load Balancer bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the resource: STACKIT has no role binding
 * on a single load balancer (see `StackitBindings`). The permissions come from
 * the spec's `x-stackit-authorization` on each operation.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.LoadBalancer.GetLoadBalancer`. */
  tag: string;
  /** What the operation needs on the project holding the resource. */
  access: StackitBindings.Access;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

export const makeLoadBalancerHttpBinding = <
  I extends { projectId: string; region: string; name: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (loadBalancer: LoadBalancer) => ({
      projectId: loadBalancer.projectId,
      region: loadBalancer.region,
      name: loadBalancer.loadBalancerName,
    }),
    grants: (loadBalancer) => [StackitBindings.grantOn(loadBalancer, options.access)],
  });

export const makeCredentialHttpBinding = <
  I extends { projectId: string; region: string; credentialsRef: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (credential: ObservabilityCredential) => ({
      projectId: credential.projectId,
      region: credential.region,
      credentialsRef: credential.credentialsRef,
    }),
    grants: (credential) => [StackitBindings.grantOn(credential, options.access)],
  });

/** A binding on the whole project and region of the bound resource. */
export const makeScopeHttpBinding = <I extends { projectId: string; region: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({
      projectId: scope.projectId,
      region: scope.region,
    }),
    grants: (scope) => [StackitBindings.grantOn(scope, options.access)],
  });

/**
 * A binding with no target and no role: the spec disables authorization on the
 * operation, so the host only needs an identity to sign with.
 */
export const makeUnscopedHttpBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.LoadBalancer.ListPlans`. */
  tag: string;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}`({ grants: [] });
      }
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* run(request);
      });
    });
  });
