import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createChildName,
  healthModelOwnedByStack,
  isSubset,
  NAMESPACE,
  sameName,
  whileBusy,
} from "./internal.ts";

/** How a discovery rule finds entities. */
export type DiscoveryRuleSpecification =
  | {
      /** Discover the resources an Azure Resource Graph query returns. */
      kind: "ResourceGraphQuery";
      /**
       * Azure Resource Graph query in KQL. It must return a column named
       * `id` with the resource ID of each discovered resource. At most
       * 5000 characters.
       */
      resourceGraphQuery: string;
    }
  | {
      /** Discover the topology of an Application Insights component. */
      kind: "ApplicationInsightsTopology";
      /** ARM resource ID of the Application Insights component. */
      applicationInsightsResourceId: string;
    };

export type DiscoveryRuleBehavior = "Enabled" | "Disabled";

export interface DiscoveryRuleProps {
  /**
   * Resource group of the health model. Changing it replaces the rule.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Health model that holds the rule. Changing it replaces the rule. */
  healthModel: string;
  /**
   * Rule name: 3-260 letters, digits, and hyphens, starting and ending with
   * a letter or digit. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the rule.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Display name shown in the portal.
   * @default none
   */
  displayName?: string;
  /**
   * Name of the `AuthenticationSetting` used to run the discovery query.
   * Discovered entities use the same setting for their signals.
   */
  authenticationSetting: string;
  /** How the rule finds entities. */
  specification: DiscoveryRuleSpecification;
  /**
   * Whether to create relationships between discovered entities from a set
   * of built-in rules. Discovered relationships cannot be deleted by hand.
   * @default "Enabled"
   */
  discoverRelationships?: DiscoveryRuleBehavior;
  /**
   * Whether to add every recommended signal to the discovered entities.
   * Each signal is evaluated as an Azure Monitor query.
   * @default "Disabled"
   */
  addRecommendedSignals?: DiscoveryRuleBehavior;
  /**
   * Whether to add a signal for each discovered resource's Azure Resource
   * Health availability state.
   * @default Azure's default (`Enabled`)
   */
  addResourceHealthSignal?: DiscoveryRuleBehavior;
}

export interface DiscoveryRule extends Resource<
  "Azure.CloudHealth.DiscoveryRule",
  DiscoveryRuleProps,
  {
    /** Name of the discovery rule. */
    discoveryRuleName: string;
    /** ARM resource ID of the discovery rule. */
    discoveryRuleId: string;
    /** Health model that holds the rule. */
    healthModelName: string;
    /** Resource group of the health model. */
    resourceGroup: string;
    /** Display name. */
    displayName: string | undefined;
    /**
     * Name of the entity that represents the rule. Azure creates it a few
     * minutes after the rule; use it as the parent of a `Relationship`.
     */
    entityName: string | undefined;
    /** Error message of the last discovery run, if it failed. */
    errorMessage: string | undefined;
    /** Provisioning state reported by Azure, e.g. `Succeeded`. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A discovery rule of an Azure Monitor health model
 * (`Microsoft.CloudHealth/healthmodels/discoveryrules`): it finds Azure
 * resources with an Azure Resource Graph query (or from an Application
 * Insights topology) and keeps matching entities, relationships, and
 * recommended signals in the model up to date.
 *
 * Discovery rules have no tags; a rule is owned by the stack that owns its
 * health model. Entities and relationships the rule discovers are managed
 * by Azure and removed with the rule.
 *
 * :::caution
 * Changing `name`, `healthModel`, or `resourceGroup` replaces the discovery
 * rule and removes every entity it discovered.
 * :::
 *
 * See [Azure Monitor health models](https://learn.microsoft.com/azure/azure-monitor/health-models/overview).
 *
 * ### Creating a Discovery Rule
 * **Example:** Discover every storage account in a resource group
 * ```typescript
 * const model = yield* Azure.CloudHealth.HealthModel("shop-health", {
 *   location: "westeurope",
 *   identity: { type: "SystemAssigned" },
 * });
 * const auth = yield* Azure.CloudHealth.AuthenticationSetting("auth", {
 *   healthModel: model.healthModelName,
 * });
 * const rule = yield* Azure.CloudHealth.DiscoveryRule("storage", {
 *   healthModel: model.healthModelName,
 *   authenticationSetting: auth.authenticationSettingName,
 *   specification: {
 *     kind: "ResourceGraphQuery",
 *     resourceGraphQuery:
 *       "resources | where type =~ 'microsoft.storage/storageaccounts' | project id",
 *   },
 *   addRecommendedSignals: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const DiscoveryRule = GroupedResource<DiscoveryRule>("Azure.CloudHealth.DiscoveryRule");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  healthModelName: string;
  discoveryRuleName: string;
}

const getRule = (where: Where) => orUndefinedIfNotFound(cloudhealth.GetDiscoveryRule(where));

const toAttrs = (
  where: Where,
  observed: cloudhealth.GetDiscoveryRuleResponse,
): DiscoveryRule["Attributes"] => ({
  discoveryRuleName: where.discoveryRuleName,
  discoveryRuleId: observed.id ?? "",
  healthModelName: where.healthModelName,
  resourceGroup: where.resourceGroupName,
  displayName: observed.properties?.displayName,
  entityName: observed.properties?.entityName,
  errorMessage: observed.properties?.error?.message,
  provisioningState: observed.properties?.provisioningState,
});

export const DiscoveryRuleProvider = () =>
  Provider.succeed(DiscoveryRule, {
    stables: ["discoveryRuleName", "discoveryRuleId", "healthModelName", "resourceGroup"],

    // Rules live inside a health model; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.healthModel, output.healthModelName) ||
        (news.name !== undefined && !sameName(news.name, output.discoveryRuleName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const healthModelName = output?.healthModelName ?? olds?.healthModel;
      if (resourceGroupName === undefined || healthModelName === undefined) return undefined;
      const where = {
        subscriptionId,
        resourceGroupName,
        healthModelName,
        discoveryRuleName: output?.discoveryRuleName ?? olds?.name ?? (yield* createChildName(id)),
      };
      const observed = yield* getRule(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return (yield* healthModelOwnedByStack(where)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        healthModelName: news.healthModel,
        discoveryRuleName: news.name ?? output?.discoveryRuleName ?? (yield* createChildName(id)),
      };
      const desired = {
        displayName: news.displayName,
        authenticationSetting: news.authenticationSetting,
        discoverRelationships: news.discoverRelationships ?? "Enabled",
        addRecommendedSignals: news.addRecommendedSignals ?? "Disabled",
        addResourceHealthSignal: news.addResourceHealthSignal,
        specification: news.specification,
      } satisfies cloudhealth.DiscoveryRulePropertiesInput;

      // Observe.
      const observed = yield* getRule(where);

      // Ensure + sync: one PUT carries every property.
      if (observed === undefined || !isSubset(desired, observed.properties)) {
        yield* cloudhealth
          .DiscoveryRulesCreateOrUpdate({ ...where, properties: desired })
          .pipe(Effect.retry(whileBusy));
      }

      const fresh = yield* waitForProvisioned(
        `health model discovery rule ${where.discoveryRuleName}`,
        getRule(where),
        (rule) => rule.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        healthModelName: output.healthModelName,
        discoveryRuleName: output.discoveryRuleName,
      };
      yield* ignoreNotFound(cloudhealth.DeleteDiscoveryRule(where).pipe(Effect.retry(whileBusy)));
      yield* waitUntilGone(
        `health model discovery rule ${output.discoveryRuleName}`,
        getRule(where),
        { interval: "5 seconds", times: 36 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.CloudHealth.HealthModel", "Azure.CloudHealth.AuthenticationSetting"],
    },
  });
