import * as StackitBindings from "../StackitBindings.ts";
import type { Configuration } from "./Configuration.ts";
import type { CustomRuleGroup } from "./CustomRuleGroup.ts";
import type { ManagedRuleSet } from "./ManagedRuleSet.ts";

/**
 * Shared HTTP scaffolding for WAF bindings.
 * NOT exported from index.ts.
 *
 * Whole-project bindings use the maker in `LoadBalancer/BindingHttp.ts`.
 *
 * Roles bind on the project holding the resource: STACKIT has no role binding
 * on a single resource (see `StackitBindings`). The permissions come from the
 * spec's `x-stackit-authorization` on each operation.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.WAF.GetConfiguration`. */
  tag: string;
  /** What the operation needs on the project holding the resource. */
  access: StackitBindings.Access;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

export const makeConfigurationHttpBinding = <
  I extends { projectId: string; region: string; name: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (configuration: Configuration) => ({
      projectId: configuration.projectId,
      region: configuration.region,
      name: configuration.configurationName,
    }),
    grants: (configuration) => [StackitBindings.grantOn(configuration, options.access)],
  });

export const makeCustomRuleGroupHttpBinding = <
  I extends { projectId: string; region: string; name: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (group: CustomRuleGroup) => ({
      projectId: group.projectId,
      region: group.region,
      name: group.ruleGroupName,
    }),
    grants: (group) => [StackitBindings.grantOn(group, options.access)],
  });

export const makeManagedRuleSetHttpBinding = <
  I extends { projectId: string; region: string; name: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (ruleSet: ManagedRuleSet) => ({
      projectId: ruleSet.projectId,
      region: ruleSet.region,
      name: ruleSet.ruleSetName,
    }),
    grants: (ruleSet) => [StackitBindings.grantOn(ruleSet, options.access)],
  });
