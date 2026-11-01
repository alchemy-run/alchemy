import type { BindingScope } from "../LoadBalancer/BindingScope.ts";
import * as StackitBindings from "../StackitBindings.ts";
import type { VolumeAutomation } from "./VolumeAutomation.ts";

/**
 * Shared HTTP scaffolding for Automation bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the resource: STACKIT has no role binding on a single
 * automation (see `StackitBindings`). The permissions come from the spec's
 * `x-stackit-authorization` on each operation.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.Automation.GetVolumeAutomation`. */
  tag: string;
  /** What the operation needs on the project holding the resource. */
  access: StackitBindings.Access;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** A binding on one automation: its project, region and id are injected. */
export const makeVolumeAutomationHttpBinding = <
  I extends { projectId: string; region: string; automationId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (bound: VolumeAutomation) => ({
      projectId: bound.projectId,
      region: bound.region,
      automationId: bound.automationId,
    }),
    grants: (bound) => [StackitBindings.grantOn(bound, options.access)],
  });

/** A binding on a whole project and region, for discovery no automation has to exist for. */
export const makeAutomationScopeHttpBinding = <
  I extends { projectId: string; region: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({ projectId: scope.projectId, region: scope.region }),
    grants: (scope) => [StackitBindings.grantOn(scope, options.access)],
  });
