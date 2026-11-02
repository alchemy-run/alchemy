import * as StackitBindings from "../StackitBindings.ts";
import type { LoadBalancer } from "./LoadBalancer.ts";
import type { ObservabilityCredential } from "./ObservabilityCredential.ts";

/**
 * Shared HTTP scaffolding for Application Load Balancer bindings.
 * NOT exported from index.ts.
 *
 * Whole-project and unscoped bindings use the makers in `LoadBalancer/BindingHttp.ts`.
 *
 * Roles bind on the project holding the resource: STACKIT has no role binding
 * on a single resource (see `StackitBindings`). The permissions come from the
 * spec's `x-stackit-authorization` on each operation.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.ALB.GetLoadBalancer`. */
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
