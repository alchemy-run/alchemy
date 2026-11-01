import * as StackitBindings from "../StackitBindings.ts";
import type { IPList } from "./IPList.ts";

/**
 * Shared HTTP scaffolding for IP Lists bindings.
 * NOT exported from index.ts.
 *
 * Whole-project bindings use the maker in `LoadBalancer/BindingHttp.ts`.
 *
 * Roles bind on the project holding the resource: STACKIT has no role binding
 * on a single resource (see `StackitBindings`). The permissions come from the
 * spec's `x-stackit-authorization` on each operation.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.IPLists.GetIPList`. */
  tag: string;
  /** What the operation needs on the project holding the resource. */
  access: StackitBindings.Access;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

export const makeIPListHttpBinding = <
  I extends { projectId: string; region: string; name: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (list: IPList) => ({
      projectId: list.projectId,
      region: list.region,
      name: list.listName,
    }),
    grants: (list) => [StackitBindings.grantOn(list, options.access)],
  });
