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
import { createChildName, NAMESPACE, sameName, whileBusy } from "./internal.ts";

export interface RelationshipProps {
  /**
   * Resource group of the health model. Changing it replaces the relationship.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Health model that holds the relationship. Changing it replaces the relationship. */
  healthModel: string;
  /**
   * Relationship name: 3-260 letters, digits, and hyphens, starting and
   * ending with a letter or digit. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the
   * relationship.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Display name.
   * @default none
   */
  displayName?: string;
  /** Name of the parent entity. Changing it replaces the relationship. */
  parentEntity: string;
  /** Name of the child entity. Changing it replaces the relationship. */
  childEntity: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Relationship extends Resource<
  "Azure.CloudHealth.Relationship",
  RelationshipProps,
  {
    /** Name of the relationship. */
    relationshipName: string;
    /** ARM resource ID of the relationship. */
    relationshipId: string;
    /** Health model that holds the relationship. */
    healthModelName: string;
    /** Resource group of the health model. */
    resourceGroup: string;
    /** Display name. */
    displayName: string | undefined;
    /** Name of the parent entity. */
    parentEntityName: string;
    /** Name of the child entity. */
    childEntityName: string;
    /** Provisioning state reported by Azure, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A relationship of an Azure Monitor health model
 * (`Microsoft.CloudHealth/healthmodels/relationships`): a parent-child edge
 * between two entities. The parent's health rolls up the health of its
 * children according to its `dependencies` signal group.
 *
 * Alchemy records ownership in the relationship's own tags.
 *
 * :::caution
 * Changing `name`, `parentEntity`, `childEntity`, `healthModel`, or
 * `resourceGroup` replaces the relationship.
 * :::
 *
 * See [Azure Monitor health models](https://learn.microsoft.com/azure/azure-monitor/health-models/overview).
 *
 * ### Creating a Relationship
 * **Example:** Make the API a child of the shop
 * ```typescript
 * const model = yield* Azure.CloudHealth.HealthModel("shop-health", {
 *   location: "westeurope",
 * });
 * const shop = yield* Azure.CloudHealth.Entity("shop", {
 *   healthModel: model.healthModelName,
 *   signalGroups: { dependencies: { aggregationType: "WorstOf" } },
 * });
 * const api = yield* Azure.CloudHealth.Entity("api", {
 *   healthModel: model.healthModelName,
 * });
 * yield* Azure.CloudHealth.Relationship("shop-api", {
 *   healthModel: model.healthModelName,
 *   parentEntity: shop.entityName,
 *   childEntity: api.entityName,
 * });
 * ```
 *
 * @resource
 */
export const Relationship = GroupedResource<Relationship>("Azure.CloudHealth.Relationship");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  healthModelName: string;
  relationshipName: string;
}

const getRelationship = (where: Where) => orUndefinedIfNotFound(cloudhealth.GetRelationship(where));

const toAttrs = (
  where: Where,
  observed: cloudhealth.GetRelationshipResponse,
): Relationship["Attributes"] => ({
  relationshipName: where.relationshipName,
  relationshipId: observed.id ?? "",
  healthModelName: where.healthModelName,
  resourceGroup: where.resourceGroupName,
  displayName: observed.properties?.displayName,
  parentEntityName: observed.properties?.parentEntityName ?? "",
  childEntityName: observed.properties?.childEntityName ?? "",
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.properties?.tags),
});

export const RelationshipProvider = () =>
  Provider.succeed(Relationship, {
    stables: ["relationshipName", "relationshipId", "healthModelName", "resourceGroup"],

    // Relationships live inside a health model; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.healthModel, output.healthModelName) ||
        (news.name !== undefined && !sameName(news.name, output.relationshipName)) ||
        !sameName(news.parentEntity, output.parentEntityName) ||
        !sameName(news.childEntity, output.childEntityName)
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
        relationshipName: output?.relationshipName ?? olds?.name ?? (yield* createChildName(id)),
      };
      const observed = yield* getRelationship(where);
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
        relationshipName: news.name ?? output?.relationshipName ?? (yield* createChildName(id)),
      };
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      const observed = yield* getRelationship(where);

      // Ensure + sync. Parent and child are the relationship's identity
      // (diff replaces on change); display name and tags update in place.
      const props = observed?.properties;
      if (
        observed === undefined ||
        (news.displayName !== undefined && props?.displayName !== news.displayName) ||
        tagsDiffer(props?.tags, tags)
      ) {
        yield* cloudhealth
          .RelationshipsCreateOrUpdate({
            ...where,
            properties: {
              displayName: news.displayName,
              parentEntityName: news.parentEntity,
              childEntityName: news.childEntity,
              tags,
            },
          })
          .pipe(Effect.retry(whileBusy));
      }

      const fresh = yield* waitForProvisioned(
        `health model relationship ${where.relationshipName}`,
        getRelationship(where),
        (relationship) => relationship.properties?.provisioningState,
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
        relationshipName: output.relationshipName,
      };
      yield* ignoreNotFound(cloudhealth.DeleteRelationship(where).pipe(Effect.retry(whileBusy)));
      yield* waitUntilGone(
        `health model relationship ${output.relationshipName}`,
        getRelationship(where),
      );
    }),

    nuke: { dependsOn: ["Azure.CloudHealth.HealthModel", "Azure.CloudHealth.Entity"] },
  });
