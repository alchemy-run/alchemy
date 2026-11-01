import * as StackitBindings from "../StackitBindings.ts";
import type { BindingScope } from "./BindingScope.ts";
import type { CustomDomain } from "./CustomDomain.ts";
import type { Distribution } from "./Distribution.ts";

/**
 * Shared HTTP scaffolding for CDN bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the resource: STACKIT has no role binding on a
 * single distribution (see `StackitBindings`). The permissions come from the spec's
 * `x-stackit-authorization` on each operation. The spec lists two for most of them,
 * and each custom role holds both, since it doesn't say whether one is enough.
 */
export const CDN_READ_ACCESS: StackitBindings.Access = { permissions: ["cdn.distribution.get"] };

export const CDN_LIST_ACCESS: StackitBindings.Access = {
  permissions: ["cdn.distribution.get", "cdn.distribution.list"],
};

export const CDN_UPDATE_ACCESS: StackitBindings.Access = {
  permissions: ["cdn.distribution.edit", "cdn.distribution.update"],
};

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.CDN.GetDistribution`. */
  tag: string;
  /** What the operation needs on the project holding the resource. */
  access: StackitBindings.Access;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** A binding over one operation on a distribution. */
export const makeDistributionHttpBinding = <
  I extends { projectId: string; distributionId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (distribution: Distribution) => ({
      projectId: distribution.projectId,
      distributionId: distribution.distributionId,
    }),
    grants: (distribution) => [StackitBindings.grantOn(distribution, options.access)],
  });

/** A binding over one operation on a custom domain. */
export const makeCustomDomainHttpBinding = <
  I extends { projectId: string; distributionId: string; domain: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (customDomain: CustomDomain) => ({
      projectId: customDomain.projectId,
      distributionId: customDomain.distributionId,
      domain: customDomain.domain,
    }),
    grants: (customDomain) => [StackitBindings.grantOn(customDomain, options.access)],
  });

/** A binding on the whole project of the bound resource. */
export const makeScopeHttpBinding = <I extends { projectId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({ projectId: scope.projectId }),
    grants: (scope) => [StackitBindings.grantOn(scope, options.access)],
  });
