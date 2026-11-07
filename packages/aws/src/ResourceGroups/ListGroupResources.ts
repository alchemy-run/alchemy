import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeResourceGroupsGroupHttpBinding } from "./BindingHttp.ts";
import type { Group } from "./Group.ts";

/** Request for {@link ListGroupResources} — the group is injected from the binding. */
export type ListGroupResourcesRequest = Omit<
  resourcegroups.ListGroupResourcesInput,
  "Group" | "GroupName"
>;

/**
 * Runtime binding for `resource-groups:ListGroupResources`.
 *
 * Enumerates the member resources of the bound {@link Group} — for a
 * tag-based group the resources currently matching the query, for an
 * application or configuration group the explicitly grouped members. The
 * group name is injected from the binding; the grant also includes the
 * `tag:GetResources` / CloudFormation read-through permissions the
 * enumeration fans out to. Provide the implementation with
 * `Effect.provide(AWS.ResourceGroups.ListGroupResourcesHttp)`.
 * ### Enumerating Group Members
 * **Example:** List A Group's Member ARNs
 * ```typescript
 * // init — bind the operation to the group
 * const listGroupResources = yield* AWS.ResourceGroups.ListGroupResources(group);
 *
 * // runtime
 * const { Resources } = yield* listGroupResources();
 * const arns = (Resources ?? []).map((r) => r.Identifier?.ResourceArn);
 * ```
 *
 * @binding
 */
export interface ListGroupResources extends Binding.Service<
  ListGroupResources,
  "AWS.ResourceGroups.ListGroupResources",
  (
    group: Group,
  ) => Effect.Effect<
    (
      request?: ListGroupResourcesRequest,
    ) => Effect.Effect<
      resourcegroups.ListGroupResourcesOutput,
      resourcegroups.ListGroupResourcesError
    >
  >
> {}
export const ListGroupResources = Binding.Service<ListGroupResources>(
  "AWS.ResourceGroups.ListGroupResources",
);

export const ListGroupResourcesHttp = Layer.effect(
  ListGroupResources,
  makeResourceGroupsGroupHttpBinding({
    tag: "AWS.ResourceGroups.ListGroupResources",
    operation: resourcegroups.listGroupResources,
    actions: ["resource-groups:ListGroupResources"],
    // Documented minimum permissions: member enumeration reads through the
    // Resource Groups Tagging API and (for CLOUDFORMATION_STACK_1_0 groups)
    // the owning stack, on arbitrary member ARNs.
    supportingActions: [
      "tag:GetResources",
      "cloudformation:DescribeStacks",
      "cloudformation:ListStackResources",
    ],
  }),
);
