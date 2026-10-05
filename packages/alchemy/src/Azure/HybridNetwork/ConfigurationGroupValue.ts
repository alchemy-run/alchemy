import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createHybridNetworkName,
  FAST_BUDGET,
  NAMESPACE,
  retryInProgress,
  sameArm,
  sameJson,
} from "./Common.ts";

export interface ConfigurationGroupValueProps {
  /** Resource group the value is created in. Changing it replaces the value. */
  resourceGroup: string;
  /**
   * Value name: 1-64 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the value.
   */
  name?: string;
  /**
   * Azure location; must be an Azure Operator Service Manager region.
   * Changing it replaces the value.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the `ConfigurationGroupSchema` the values conform to.
   * Changing it replaces the value.
   */
  configurationGroupSchemaId: string;
  /**
   * Configuration values as a JSON string (an `Open` configuration).
   * Updated in place. Mutually exclusive with `secretConfigurationValue`.
   */
  configurationValue?: string;
  /**
   * Configuration values as a JSON string stored as a secret (a `Secret`
   * configuration). Azure never returns it, so changes are detected by
   * hash. Switching between an open and a secret value replaces the
   * resource.
   */
  secretConfigurationValue?: string | Redacted.Redacted<string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ConfigurationGroupValue extends Resource<
  "Azure.HybridNetwork.ConfigurationGroupValue",
  ConfigurationGroupValueProps,
  {
    /** Name of the configuration group value. */
    configurationGroupValueName: string;
    /** ARM resource ID of the configuration group value. */
    configurationGroupValueId: string;
    /** Resource group that holds the value. */
    resourceGroup: string;
    /** Location of the value. */
    location: string;
    /** ARM ID of the referenced configuration group schema. */
    configurationGroupSchemaId: string;
    /** Name of the referenced configuration group schema. */
    configurationGroupSchemaName: string | undefined;
    /** Location of the referenced schema offering. */
    configurationGroupSchemaOfferingLocation: string | undefined;
    /** Name of the publisher that owns the schema. */
    publisherName: string | undefined;
    /** `Open` or `Secret`. */
    configurationType: "Open" | "Secret";
    /** Configuration values JSON (`Open` values only). */
    configurationValue: string | undefined;
    /** SHA-256 of the last applied secret value (`Secret` values only). */
    secretValueHash: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Service Manager configuration group value — the
 * concrete configuration an operator supplies for a publisher's
 * configuration group schema when deploying a site network service.
 *
 * Configuration group values are free metadata resources.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/configuration-guide
 *
 * ### Creating a Value
 * **Example:** Open configuration values
 * ```typescript
 * const values = yield* Azure.HybridNetwork.ConfigurationGroupValue("values", {
 *   resourceGroup: group.resourceGroupName,
 *   configurationGroupSchemaId: schema.configurationGroupSchemaId,
 *   configurationValue: JSON.stringify({ region: "eastus" }),
 * });
 * ```
 *
 * **Example:** Secret configuration values
 * ```typescript
 * const secrets = yield* Azure.HybridNetwork.ConfigurationGroupValue("secrets", {
 *   resourceGroup: group.resourceGroupName,
 *   configurationGroupSchemaId: schema.configurationGroupSchemaId,
 *   secretConfigurationValue: Redacted.make(
 *     JSON.stringify({ adminPassword: process.env.ADMIN_PASSWORD }),
 *   ),
 * });
 * ```
 *
 * @resource
 */
export const ConfigurationGroupValue = Resource<ConfigurationGroupValue>(
  "Azure.HybridNetwork.ConfigurationGroupValue",
);

const getValue = (
  subscriptionId: string,
  resourceGroupName: string,
  configurationGroupValueName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetConfigurationGroupValue({
      subscriptionId,
      resourceGroupName,
      configurationGroupValueName,
    }),
  );

const hashSecret = (value: string | Redacted.Redacted<string>) =>
  Effect.sync(() =>
    createHash("sha256")
      .update(Redacted.isRedacted(value) ? Redacted.value(value) : value)
      .digest("hex"),
  );

const typeOf = (props: {
  secretConfigurationValue?: unknown;
}): "Open" | "Secret" =>
  props.secretConfigurationValue !== undefined ? "Secret" : "Open";

const toAttrs = (
  resourceGroup: string,
  name: string,
  value:
    | hybridnetwork.GetConfigurationGroupValueResponse
    | hybridnetwork.ConfigurationGroupValue,
  secretValueHash: string | undefined,
): ConfigurationGroupValue["Attributes"] => {
  const configurationType =
    value.properties?.configurationType === "Secret" ? "Secret" : "Open";
  return {
    configurationGroupValueName: name,
    configurationGroupValueId: value.id ?? "",
    resourceGroup,
    location: value.location,
    configurationGroupSchemaId:
      value.properties?.configurationGroupSchemaResourceReference?.id ?? "",
    configurationGroupSchemaName: value.properties?.configurationGroupSchemaName,
    configurationGroupSchemaOfferingLocation:
      value.properties?.configurationGroupSchemaOfferingLocation,
    publisherName: value.properties?.publisherName,
    configurationType,
    configurationValue:
      configurationType === "Open"
        ? value.properties?.configurationValue
        : undefined,
    secretValueHash: configurationType === "Secret" ? secretValueHash : undefined,
    tags: userTags(value.tags),
  };
};

export const ConfigurationGroupValueProvider = () =>
  Provider.succeed(ConfigurationGroupValue, {
    stables: [
      "configurationGroupValueName",
      "configurationGroupValueId",
      "resourceGroup",
      "location",
      "configurationGroupSchemaId",
      "configurationType",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* hybridnetwork
        .ListConfigurationGroupValueBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListConfigurationGroupValueBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((value) => {
        const group = resourceGroupOf(value.id);
        return hasAnyAlchemyTag(value.tags) &&
          group !== undefined &&
          value.name !== undefined
          ? [toAttrs(group, value.name, value, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameName =
        news.name === undefined ||
        news.name === output.configurationGroupValueName;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameName ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(
          news.configurationGroupSchemaId,
          output.configurationGroupSchemaId,
        ) ||
        typeOf(news) !== output.configurationType
      ) {
        return {
          action: "replace",
          deleteFirst: news.name !== undefined && sameName,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.configurationGroupValueName ??
        olds?.name ??
        (yield* createHybridNetworkName(id));
      const observed = yield* getValue(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        output?.secretValueHash,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.configurationGroupValueName ??
        (yield* createHybridNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const configurationType = typeOf(news);
      const secret = news.secretConfigurationValue;
      const secretValueHash =
        secret === undefined ? undefined : yield* hashSecret(secret);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        configurationGroupValueName: name,
      };
      const get = getValue(subscriptionId, resourceGroup, name);
      const label = `AOSM configuration group value ${name}`;
      // Secret values are write-only: the hash of the last applied value
      // is the only observation available.
      const valueDiffers = (
        observed: hybridnetwork.GetConfigurationGroupValueResponse,
      ) =>
        configurationType === "Secret"
          ? output?.secretValueHash !== secretValueHash
          : !sameJson(
              observed.properties?.configurationValue,
              news.configurationValue ?? "{}",
            );

      // Observe.
      let observed = yield* get;

      // Ensure (and sync the values, which are only writable by PUT).
      if (observed === undefined || valueDiffers(observed)) {
        yield* retryInProgress(
          hybridnetwork.ConfigurationGroupValuesCreateOrUpdate({
            ...where,
            location: observed?.location ?? location,
            tags,
            properties: {
              configurationType,
              configurationGroupSchemaResourceReference: {
                idType: "Open",
                id: news.configurationGroupSchemaId,
              },
              ...(configurationType === "Secret"
                ? {
                    secretConfigurationValue: Redacted.isRedacted(secret)
                      ? Redacted.value(secret)
                      : secret,
                  }
                : { configurationValue: news.configurationValue ?? "{}" }),
            },
          }),
        );
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (value) =>
          configurationType === "Open" && valueDiffers(value)
            ? "Updating"
            : value.properties?.provisioningState,
        FAST_BUDGET,
      );

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* retryInProgress(
          hybridnetwork.UpdateConfigurationGroupValueTags({ ...where, tags }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (value) =>
            tagsDiffer(value.tags, tags)
              ? "Updating"
              : value.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed, secretValueHash);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridnetwork
          .DeleteConfigurationGroupValue({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            configurationGroupValueName: output.configurationGroupValueName,
          })
          .pipe(retryInProgress),
      );
      yield* waitUntilGone(
        `AOSM configuration group value ${output.configurationGroupValueName}`,
        getValue(
          subscriptionId,
          output.resourceGroup,
          output.configurationGroupValueName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
