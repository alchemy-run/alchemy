import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createChildName, isSubset, NAMESPACE, sameName, whileBusy } from "./internal.ts";

/** Signal groups (Azure resource metrics, Log Analytics, Prometheus, child dependencies) of an entity. */
export type EntitySignalGroups = cloudhealth.SignalGroupsInput;
/** A named aggregation over a subset of an entity's signals. */
export type EntitySignalAggregationGroup = cloudhealth.SignalAggregationGroupInput;
/** Alerts raised when the entity turns degraded or unhealthy. */
export type EntityAlerts = cloudhealth.EntityAlerts;
/** Position of the entity on the model canvas. */
export type EntityCoordinates = cloudhealth.EntityCoordinates;
/** Icon of the entity on the model canvas. */
export type EntityIcon = cloudhealth.IconDefinition;
/** How much the entity's health counts when its parents aggregate health. */
export type EntityImpact = "Standard" | "Limited" | "Suppressed";

export interface EntityProps {
  /** Resource group of the health model. Changing it replaces the entity. */
  resourceGroup: string;
  /** Health model that holds the entity. Changing it replaces the entity. */
  healthModel: string;
  /**
   * Entity name: 3-260 letters, digits, and hyphens, starting and ending
   * with a letter or digit. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the entity.
   */
  name?: string;
  /** Display name shown on the model canvas. */
  displayName?: string;
  /** Position on the model canvas. */
  canvasPosition?: EntityCoordinates;
  /** Icon on the model canvas. @default a built-in icon */
  icon?: EntityIcon;
  /** Health objective: the percentage of time the entity should be healthy. */
  healthObjective?: number;
  /**
   * Impact of the entity on its parents' health.
   * @default "Standard"
   */
  impact?: EntityImpact;
  /**
   * Signals that compute the entity's health: Azure resource metrics, Log
   * Analytics queries, Prometheus queries, and how children roll up.
   */
  signalGroups?: EntitySignalGroups;
  /** Aggregation groups over the entity's signals. */
  signalAggregationGroups?: EntitySignalAggregationGroup[];
  /** Alerts raised when the entity turns degraded or unhealthy. */
  alerts?: EntityAlerts;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Entity extends Resource<
  "Azure.CloudHealth.Entity",
  EntityProps,
  {
    /** Name of the entity; reference it from a `Relationship`. */
    entityName: string;
    /** ARM resource ID of the entity. */
    entityId: string;
    /** Health model that holds the entity. */
    healthModelName: string;
    /** Resource group of the health model. */
    resourceGroup: string;
    /** Display name. */
    displayName: string | undefined;
    /** Impact on parent health. */
    impact: string | undefined;
    /** Current health state: `Healthy`, `Degraded`, `Unhealthy`, or `Unknown`. */
    healthState: string | undefined;
    /** Provisioning state reported by Azure, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An entity of an Azure Monitor health model
 * (`Microsoft.CloudHealth/healthmodels/entities`): a node of the model,
 * such as a service, a component, or an Azure resource, whose health is
 * computed from its signals and from its children.
 *
 * Signal groups reference an `AuthenticationSetting` by name and may use
 * `SignalDefinition`s for shared thresholds. Alchemy records ownership in
 * the entity's own tags.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/health-models/overview
 *
 * ### Creating an Entity
 * **Example:** Entity with a storage availability signal
 * ```typescript
 * const model = yield* Azure.CloudHealth.HealthModel("shop-health", {
 *   location: "westeurope",
 *   identity: { type: "SystemAssigned" },
 * });
 * const auth = yield* Azure.CloudHealth.AuthenticationSetting("auth", {
 *   healthModel: model.healthModelName,
 * });
 * const storage = yield* Azure.Storage.StorageAccount("data");
 * const data = yield* Azure.CloudHealth.Entity("data", {
 *   healthModel: model.healthModelName,
 *   displayName: "Data",
 *   signalGroups: {
 *     azureResource: {
 *       authenticationSetting: auth.authenticationSettingName,
 *       azureResourceId: storage.storageAccountId,
 *       signals: [
 *         {
 *           signalKind: "AzureResourceMetric",
 *           name: "availability",
 *           metricNamespace: "microsoft.storage/storageaccounts",
 *           metricName: "Availability",
 *           timeGrain: "PT5M",
 *           aggregationType: "Average",
 *           evaluationRules: {
 *             degradedRule: { operator: "LessThan", threshold: 99.9 },
 *             unhealthyRule: { operator: "LessThan", threshold: 99 },
 *           },
 *         },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * ### Rolling Up Health
 * **Example:** Parent entity that is unhealthy when any child is
 * ```typescript
 * const shop = yield* Azure.CloudHealth.Entity("shop", {
 *   healthModel: model.healthModelName,
 *   displayName: "Shop",
 *   signalGroups: { dependencies: { aggregationType: "WorstOf" } },
 * });
 * ```
 *
 * :::caution
 * Changing `name`, `healthModel`, or `resourceGroup` replaces the entity
 * and removes its relationships.
 * :::
 *
 * @resource
 */
export const Entity = GroupedResource<Entity>("Azure.CloudHealth.Entity");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  healthModelName: string;
  entityName: string;
}

const getEntity = (where: Where) => orUndefinedIfNotFound(cloudhealth.GetEntity(where));

const toAttrs = (where: Where, observed: cloudhealth.GetEntityResponse): Entity["Attributes"] => ({
  entityName: where.entityName,
  entityId: observed.id ?? "",
  healthModelName: where.healthModelName,
  resourceGroup: where.resourceGroupName,
  displayName: observed.properties?.displayName,
  impact: observed.properties?.impact,
  healthState: observed.properties?.healthState,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.properties?.tags),
});

export const EntityProvider = () =>
  Provider.succeed(Entity, {
    stables: ["entityName", "entityId", "healthModelName", "resourceGroup"],

    // Entities live inside a health model; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.healthModel, output.healthModelName) ||
        (news.name !== undefined && !sameName(news.name, output.entityName))
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
        entityName: output?.entityName ?? olds?.name ?? (yield* createChildName(id)),
      };
      const observed = yield* getEntity(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return (yield* isOwned(id, observed.properties?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        healthModelName: news.healthModel,
        entityName: news.name ?? output?.entityName ?? (yield* createChildName(id)),
      };
      const tags = yield* desiredTags(id, news.tags);
      const desired = {
        displayName: news.displayName,
        canvasPosition: news.canvasPosition,
        icon: news.icon,
        healthObjective: news.healthObjective,
        impact: news.impact ?? "Standard",
        signalGroups: news.signalGroups,
        signalAggregationGroups: news.signalAggregationGroups,
        alerts: news.alerts,
      } satisfies cloudhealth.EntityPropertiesInput;

      // Observe.
      const observed = yield* getEntity(where);

      // Ensure + sync: one PUT carries every property, so it runs only when
      // the observed entity differs from the desired one.
      if (
        observed === undefined ||
        !isSubset(desired, observed.properties) ||
        tagsDiffer(observed.properties?.tags, tags)
      ) {
        yield* cloudhealth
          .EntitiesCreateOrUpdate({ ...where, properties: { ...desired, tags } })
          .pipe(Effect.retry(whileBusy));
      }

      const fresh = yield* waitForProvisioned(
        `health model entity ${where.entityName}`,
        getEntity(where),
        (entity) => entity.properties?.provisioningState,
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
        entityName: output.entityName,
      };
      yield* ignoreNotFound(cloudhealth.DeleteEntity(where).pipe(Effect.retry(whileBusy)));
      yield* waitUntilGone(`health model entity ${output.entityName}`, getEntity(where));
    }),

    nuke: {
      dependsOn: [
        "Azure.CloudHealth.HealthModel",
        "Azure.CloudHealth.AuthenticationSetting",
        "Azure.CloudHealth.SignalDefinition",
      ],
    },
  });
