import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { ContainerGroup } from "./ContainerGroup.ts";

/**
 * Shared scaffolding for the Container Instances runtime-action bindings
 * (start, stop, restart a container group from a running host). NOT
 * exported from `index.ts`: every `{Op}Http.ts` is a thin
 * `Layer.effect(Cap, makeContainerGroupActionBinding({ … }))`.
 *
 * The built-in **Azure Container Instances Contributor Role** grants every
 * `Microsoft.ContainerInstance/*` action (create, update, delete, exec), so
 * each binding kind gets a custom role (`Azure.Authorization.RoleDefinition`,
 * one per stack, defined at the subscription) with exactly its action,
 * assigned only on the bound container group.
 */

const GROUPS = "Microsoft.ContainerInstance/containerGroups";

/** A custom role a binding assigns on the group; the logical ID is `AzureContainerInstance<role>Role`. */
export interface ContainerInstanceGrant {
  readonly role: string;
  readonly actions: readonly string[];
}

/** Custom role per runtime action (Azure RBAC operation names). */
export const ContainerInstanceRole = {
  ContainerGroupStart: { role: "ContainerGroupStart", actions: [`${GROUPS}/start/action`] },
  ContainerGroupStop: { role: "ContainerGroupStop", actions: [`${GROUPS}/stop/action`] },
  ContainerGroupRestart: { role: "ContainerGroupRestart", actions: [`${GROUPS}/restart/action`] },
} as const satisfies Record<string, ContainerInstanceGrant>;

/** Attach the binding to its host and assign `grant` on the container group. */
const GrantOnContainerGroup = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, group: ContainerGroup, grant: ContainerInstanceGrant) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureContainerInstance${grant.role}Role`, {
        description: `Alchemy Container Instances binding: ${grant.actions.join(", ")}`,
        permissions: [{ actions: [...grant.actions] }],
      });
      yield* bind`${tag}(${group})`({
        roleAssignments: [
          { roleDefinitionId: role.roleDefinitionId, scope: group.containerGroupId },
        ],
      });
    }
  });
});

/** Subscription, resource group, and name of an ARM resource ID. */
const parseResourceId = (resourceId: string) => {
  const parts = resourceId.split("/");
  return {
    subscriptionId: parts[2] ?? "",
    resourceGroupName: parts[4] ?? "",
    name: parts[parts.length - 1] ?? "",
  };
};

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;

type ContainerGroupKeys = "subscriptionId" | "resourceGroupName" | "containerGroupName";

/**
 * Build the impl Effect for an action on a {@link ContainerGroup}: the
 * runtime callable injects the group's subscription, resource group, and
 * name (parsed from its ARM ID), and the deploy-time half assigns `grant` on
 * the group.
 */
export const makeContainerGroupActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; containerGroupName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.ContainerInstance.StartContainerGroup`. */
  tag: string;
  /** The distilled operation; the group's identifiers are injected. */
  operation: Operation<I, A, E>;
  /** Custom role assigned on the group. */
  grant: ContainerInstanceGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnContainerGroup;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (group: ContainerGroup) {
      yield* grant(options.tag, group, options.grant);
      const containerGroupId = yield* group.containerGroupId;
      return Effect.fn(`${options.tag}(${group.LogicalId})`)(function* (
        request?: Omit<I, ContainerGroupKeys>,
      ) {
        const id = yield* containerGroupId;
        const { subscriptionId, resourceGroupName, name } = parseResourceId(id);
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({
          ...request,
          subscriptionId,
          resourceGroupName,
          containerGroupName: name,
        } as I);
      });
    });
  });
