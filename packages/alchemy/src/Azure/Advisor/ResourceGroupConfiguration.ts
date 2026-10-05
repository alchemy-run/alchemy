import * as advisor from "@distilled.cloud/azure/advisor";
import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface ResourceGroupConfigurationProps {
  /**
   * Resource group whose Advisor configuration is managed. Changing it
   * replaces the configuration resource.
   */
  resourceGroup: string;
  /**
   * Exclude every resource in the resource group from Azure Advisor
   * evaluations (no recommendations are generated for them).
   * @default false
   */
  exclude?: boolean;
}

export interface ResourceGroupConfiguration extends Resource<
  "Azure.Advisor.ResourceGroupConfiguration",
  ResourceGroupConfigurationProps,
  {
    /** Resource group whose Advisor configuration is managed. */
    resourceGroup: string;
    /**
     * ARM resource ID of the configuration
     * (`.../providers/Microsoft.Advisor/configurations/default`).
     */
    configurationId: string;
    /** Whether the resource group is excluded from Advisor evaluations. */
    exclude: boolean;
  },
  never,
  Providers
> {}

/**
 * The Azure Advisor configuration of a resource group
 * (`Microsoft.Advisor/configurations/default`), which controls whether
 * Advisor evaluates the resources in the group.
 *
 * This is a singleton: every resource group has exactly one Advisor
 * configuration and Azure offers no delete. Destroying the resource resets
 * the configuration to Azure's default (`exclude: false`). Ownership is
 * inherited from the resource group's Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/advisor/advisor-get-started#configure-advisor
 *
 * ### Excluding a Resource Group
 * **Example:** Exclude a sandbox resource group from Advisor
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("sandbox", {});
 * yield* Azure.Advisor.ResourceGroupConfiguration("sandbox-advisor", {
 *   resourceGroup: group.resourceGroupName,
 *   exclude: true,
 * });
 * ```
 *
 * ### Re-including a Resource Group
 * **Example:** Explicitly keep Advisor evaluations enabled
 * ```typescript
 * yield* Azure.Advisor.ResourceGroupConfiguration("app-advisor", {
 *   resourceGroup: group.resourceGroupName,
 *   exclude: false,
 * });
 * ```
 *
 * @resource
 */
export const ResourceGroupConfiguration = Resource<ResourceGroupConfiguration>(
  "Azure.Advisor.ResourceGroupConfiguration",
);

const CONFIGURATION_NAME = "default";

const configurationIdOf = (subscriptionId: string, resourceGroup: string) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Advisor/configurations/${CONFIGURATION_NAME}`;

/**
 * Observe the `default` configuration. `undefined` when the resource group
 * is gone; a group that was never configured reports Azure's defaults.
 */
const observe = Effect.fn(function* (
  subscriptionId: string,
  resourceGroup: string,
) {
  const listed = yield* orUndefinedIfNotFound(
    advisor.ListConfigurationByResourceGroup({ subscriptionId, resourceGroup }),
  );
  if (listed === undefined) return undefined;
  const config = (listed.value ?? []).find(
    (entry) => entry.name?.toLowerCase() === CONFIGURATION_NAME,
  );
  return {
    resourceGroup,
    configurationId:
      config?.id ?? configurationIdOf(subscriptionId, resourceGroup),
    exclude: config?.properties?.exclude ?? false,
  } satisfies ResourceGroupConfiguration["Attributes"];
});

/** Whether the resource group is tagged as owned by this stack and stage. */
const isGroupOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
) {
  const group = yield* orUndefinedIfNotFound(
    resources.GetResourceGroup({ subscriptionId, resourceGroupName }),
  );
  if (group === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(group.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

export const ResourceGroupConfigurationProvider = () =>
  Provider.succeed(ResourceGroupConfiguration, {
    stables: ["resourceGroup", "configurationId"],

    // A per-resource-group singleton that disappears with its group.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const attrs = yield* observe(subscriptionId, resourceGroup);
      if (attrs === undefined) return undefined;
      return (yield* isGroupOwnedByStack(subscriptionId, resourceGroup))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Advisor");
      const { resourceGroup } = news;
      const desiredExclude = news.exclude ?? false;

      // Observe. The configuration exists implicitly for every group.
      const observed = yield* observe(subscriptionId, resourceGroup);
      if (observed !== undefined && observed.exclude === desiredExclude) {
        return observed;
      }

      // Sync the single mutable aspect.
      const written = yield* advisor.CreateConfigurationInResourceGroup({
        subscriptionId,
        resourceGroup,
        configurationName: CONFIGURATION_NAME,
        properties: { exclude: desiredExclude },
      });
      return {
        resourceGroup,
        configurationId:
          written.id ?? configurationIdOf(subscriptionId, resourceGroup),
        exclude: written.properties?.exclude ?? desiredExclude,
      };
    }),

    // No DELETE exists: reset to Azure's default. A missing resource group
    // means there is nothing left to reset.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const observed = yield* observe(subscriptionId, output.resourceGroup);
      if (observed === undefined || !observed.exclude) return;
      yield* ignoreNotFound(
        advisor.CreateConfigurationInResourceGroup({
          subscriptionId,
          resourceGroup: output.resourceGroup,
          configurationName: CONFIGURATION_NAME,
          properties: { exclude: false },
        }),
      );
    }),

    nuke: { singleton: true },
  });
