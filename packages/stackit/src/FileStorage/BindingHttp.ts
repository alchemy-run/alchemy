import * as StackitBindings from "../StackitBindings.ts";
import type { BindingScope } from "./BindingScope.ts";
import type { ResourcePool } from "./ResourcePool.ts";
import type { Share } from "./Share.ts";
import type { ShareExportPolicy } from "./ShareExportPolicy.ts";

/**
 * Shared HTTP scaffolding for File Storage bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the resource: STACKIT has no role binding on a
 * single pool, share or policy (see `StackitBindings`). The permissions are the
 * `x-stackit-authorization` actions in the service's API spec. Note that the spec guards
 * single reads with the `.list` action.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.FileStorage.GetShare`. */
  tag: string;
  /** What the operation needs on the project holding the resource. */
  access: StackitBindings.Access;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** A binding on one resource pool. */
export const makeResourcePoolHttpBinding = <
  I extends { projectId: string; region: string; resourcePoolId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (pool: ResourcePool) => ({
      projectId: pool.projectId,
      region: pool.region,
      resourcePoolId: pool.resourcePoolId,
    }),
    grants: (pool) => [StackitBindings.grantOn(pool, options.access)],
  });

/** A binding on one share. */
export const makeShareHttpBinding = <
  I extends { projectId: string; region: string; resourcePoolId: string; shareId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (share: Share) => ({
      projectId: share.projectId,
      region: share.region,
      resourcePoolId: share.resourcePoolId,
      shareId: share.shareId,
    }),
    grants: (share) => [StackitBindings.grantOn(share, options.access)],
  });

/** A binding on one share export policy. */
export const makeShareExportPolicyHttpBinding = <
  I extends { projectId: string; region: string; policyId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (policy: ShareExportPolicy) => ({
      projectId: policy.projectId,
      region: policy.region,
      policyId: policy.policyId,
    }),
    grants: (policy) => [StackitBindings.grantOn(policy, options.access)],
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
