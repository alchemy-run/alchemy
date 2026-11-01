import * as StackitBindings from "../StackitBindings.ts";
import type { Instance } from "./Instance.ts";

/**
 * Shared HTTP scaffolding for Key Value Store bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the instance: STACKIT has no role binding on a
 * single instance (see `StackitBindings`). The grants list exactly the permissions
 * an operation needs. The names are the `x-stackit-authorization` actions in the
 * service's API spec.
 */

/** Build a binding over one operation on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; regionId: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.Valkey.GetInstance`. */
  tag: string;
  /** The permission the operation needs on the project holding the instance. */
  permission: string;
  /** The distilled operation; the instance's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      regionId: instance.region,
      instanceId: instance.instanceId,
    }),
    grants: (instance) => [
      StackitBindings.grantOn(instance, { permissions: [options.permission] }),
    ],
  });
