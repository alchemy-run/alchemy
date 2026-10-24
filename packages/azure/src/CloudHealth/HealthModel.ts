import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createHealthModelName,
  getHealthModel,
  NAMESPACE,
  sameName,
  whileBusy,
} from "./internal.ts";

export type HealthModelIdentityType =
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface HealthModelIdentity {
  /** Identity type. */
  type: HealthModelIdentityType;
  /**
   * ARM resource IDs of user-assigned identities attached to the model.
   * Required when `type` includes `UserAssigned`.
   */
  userAssignedIdentities?: string[];
}

export interface HealthModelProps {
  /**
   * Resource group the health model is created in. Changing it replaces
   * the model.
   */
  resourceGroup: string;
  /**
   * Health model name: 3-44 letters, digits, and hyphens, starting with a
   * letter and ending with a letter or digit. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * model.
   */
  name?: string;
  /**
   * Azure location of the health model. Health models are offered in a
   * subset of regions (for example `centralus`, `westus3`, `westeurope`,
   * `northeurope`, `uksouth`, `swedencentral`, `australiaeast`); other
   * regions fail with `LocationNotAvailable`. Changing it replaces the
   * model.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Managed identity of the model. The model queries Azure Monitor and
   * Azure Resource Graph with it: reference it from an
   * `AuthenticationSetting` and grant it read access (for example `Reader`
   * and `Monitoring Reader`) on the monitored resources.
   * @default no identity
   */
  identity?: HealthModelIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface HealthModel extends Resource<
  "Azure.CloudHealth.HealthModel",
  HealthModelProps,
  {
    /** Name of the health model. */
    healthModelName: string;
    /** ARM resource ID of the health model. */
    healthModelId: string;
    /** Resource group that holds the health model. */
    resourceGroup: string;
    /** Location of the health model. */
    location: string;
    /** Provisioning state reported by Azure, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Identity type of the model, if any. */
    identityType: string | undefined;
    /**
     * Object ID of the model's system-assigned identity. Use it as the
     * `principalId` of a role assignment.
     */
    principalId: string | undefined;
    /** Microsoft Entra tenant of the model's identity. */
    tenantId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Monitor health model (`Microsoft.CloudHealth/healthmodels`): a
 * graph of entities (services, components, Azure resources) whose health
 * is computed from signals (Azure Monitor metrics, Log Analytics and
 * Prometheus queries) and rolled up through relationships, so you see the
 * health of a whole workload instead of single resources.
 *
 * The model holds authentication settings, discovery rules, entities,
 * relationships, and signal definitions. An empty model costs nothing;
 * signal evaluation is billed as Azure Monitor queries.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/health-models/overview
 *
 * ### Creating a Health Model
 * **Example:** Health model with a system-assigned identity
 * ```typescript
 * const model = yield* Azure.CloudHealth.HealthModel("shop-health", {
 *   location: "westeurope",
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * **Example:** User-assigned identity, tagged
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("health");
 * const model = yield* Azure.CloudHealth.HealthModel("shop-health", {
 *   location: "westeurope",
 *   identity: {
 *     type: "UserAssigned",
 *     userAssignedIdentities: [identity.identityId],
 *   },
 *   tags: { team: "sre" },
 * });
 * ```
 *
 * :::caution
 * Changing `name`, `location`, or `resourceGroup` replaces the health model
 * and deletes every entity, relationship, and rule in it.
 * :::
 *
 * @resource
 */
export const HealthModel = GroupedResource<HealthModel>("Azure.CloudHealth.HealthModel");

type ObservedModel = cloudhealth.GetHealthModelResponse | cloudhealth.HealthModel;

const toAttrs = (
  resourceGroup: string,
  name: string,
  model: ObservedModel,
): HealthModel["Attributes"] => ({
  healthModelName: name,
  healthModelId: model.id ?? "",
  resourceGroup,
  location: model.location,
  provisioningState: model.properties?.provisioningState,
  identityType: model.identity?.type,
  principalId: model.identity?.principalId,
  tenantId: model.identity?.tenantId,
  tags: userTags(model.tags),
});

const toIdentity = (identity: HealthModelIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentities?.length
          ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
          : undefined,
      };

const identityDiffers = (
  observed: ObservedModel["identity"],
  desired: HealthModelIdentity | undefined,
) => {
  if (!sameName(observed?.type ?? "None", desired?.type ?? "None")) return true;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired?.userAssignedIdentities ?? []).map((id) => id.toLowerCase()).sort();
  return have.length !== want.length || have.some((id, i) => id !== want[i]);
};

const normalizeLocation = (location: string | undefined) =>
  location?.toLowerCase().replace(/\s/g, "");

export const HealthModelProvider = () =>
  Provider.succeed(HealthModel, {
    stables: ["healthModelName", "healthModelId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* cloudhealth
        .ListHealthModelBySubscription({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListHealthModelBySubscription", page)));
      return (page.value ?? []).flatMap((model) => {
        const group = resourceGroupOf(model.id);
        return hasAnyAlchemyTag(model.tags) && group !== undefined && model.name !== undefined
          ? [toAttrs(group, model.name, model)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.healthModelName)) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !== normalizeLocation(output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.healthModelName ?? olds?.name ?? (yield* createHealthModelName(id));
      const observed = yield* getHealthModel({
        subscriptionId,
        resourceGroupName: resourceGroup,
        healthModelName: name,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.healthModelName ?? (yield* createHealthModelName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        healthModelName: name,
      };
      const get = getHealthModel(where);
      const waitReady = waitForProvisioned(
        `health model ${name}`,
        get,
        (model) => model.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* cloudhealth
          .CreateHealthModel({
            ...where,
            location,
            tags,
            identity: toIdentity(news.identity),
            properties: {},
          })
          .pipe(Effect.retry(whileBusy));
      }
      observed = yield* waitReady;

      // Sync tags and identity via PATCH against observed state.
      const patchIdentity = identityDiffers(observed.identity, news.identity);
      if (tagsDiffer(observed.tags, tags) || patchIdentity) {
        yield* cloudhealth
          .UpdateHealthModel({
            ...where,
            tags,
            identity: patchIdentity ? (toIdentity(news.identity) ?? { type: "None" }) : undefined,
          })
          .pipe(Effect.retry(whileBusy));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        healthModelName: output.healthModelName,
      };
      yield* ignoreNotFound(cloudhealth.DeleteHealthModel(where).pipe(Effect.retry(whileBusy)));
      yield* waitUntilGone(`health model ${output.healthModelName}`, getHealthModel(where), {
        interval: "5 seconds",
        times: 60,
      });
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
