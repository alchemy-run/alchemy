import * as apim from "@distilled.cloud/azure/apimanagement";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  type WaitBudget,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { getService, sameName } from "./Common.ts";

export type ServiceSkuName = apim.ApiManagementServiceSkuPropertiesName;
export type ServiceIdentityType = apim.ApiManagementServiceIdentityInputType;

export interface ServiceSku {
  /**
   * Pricing tier. Moving between the Consumption, classic (`Developer`,
   * `Basic`, `Standard`, `Premium`, `Isolated`), and v2 (`BasicV2`,
   * `StandardV2`) families replaces the service; changes within a family
   * are applied in place (classic tier changes take 15-45 minutes).
   */
  name: ServiceSkuName;
  /**
   * Number of scale units. Must be `0` for `Consumption`.
   * @default 0 for Consumption, else 1
   */
  capacity?: number;
}

export interface ServiceIdentity {
  /** Managed identity type. */
  type: ServiceIdentityType;
  /**
   * ARM ids of user-assigned identities to attach.
   * @default none
   */
  userAssignedIdentities?: string[];
}

export interface ServiceProps {
  /** Resource group the service is created in. Changing it replaces the service. */
  resourceGroup: string;
  /**
   * Globally unique service name (the gateway host is
   * `{name}.azure-api.net`): 1-50 letters, digits, and hyphens, starting
   * with a letter. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the service.
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the service. Changing it replaces the service.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier and capacity.
   * @default { name: "Consumption", capacity: 0 }
   */
  sku?: ServiceSku;
  /** Publisher email, used for system notifications. */
  publisherEmail: string;
  /** Publisher (organization) name shown in the developer portal and emails. */
  publisherName: string;
  /**
   * Sender address for notification emails.
   * @default not set
   */
  notificationSenderEmail?: string;
  /**
   * Managed identity of the service (needed for Key Vault references).
   * @default no managed identity
   */
  identity?: ServiceIdentity;
  /**
   * Gateway TLS/cipher toggles, e.g.
   * `Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11`.
   * Only the listed keys are synced.
   * @default not set (Azure's defaults apply)
   */
  customProperties?: Record<string, string>;
  /**
   * Require a client certificate on every gateway request (Consumption only).
   * @default not set (Azure's default applies)
   */
  enableClientCertificate?: boolean;
  /**
   * Whether the public endpoint accepts traffic.
   * @default not set (Azure's default applies)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Disable the gateway in the primary region (multi-region Premium only).
   * @default not set (Azure's default applies)
   */
  disableGateway?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Service extends Resource<
  "Azure.ApiManagement.Service",
  ServiceProps,
  {
    /** Name of the API Management service. */
    serviceName: string;
    /** ARM resource ID of the service. */
    serviceId: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** Location of the service. */
    location: string;
    /** Pricing tier. */
    sku: string;
    /** Number of scale units. */
    capacity: number;
    /** Gateway URL, e.g. `https://{name}.azure-api.net`. */
    gatewayUrl: string | undefined;
    /** Legacy publisher portal URL (classic tiers). */
    portalUrl: string | undefined;
    /** Developer portal URL (classic and v2 tiers). */
    developerPortalUrl: string | undefined;
    /** Management API URL (classic tiers). */
    managementApiUrl: string | undefined;
    /** Public IP addresses of the gateway (classic tiers). */
    publicIPAddresses: string[];
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** Tenant ID of the system-assigned identity, if enabled. */
    tenantId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure API Management service (`Microsoft.ApiManagement/service`) —
 * the gateway, management plane, and developer portal that APIs,
 * products, and subscriptions live in.
 *
 * Deleting a service soft-deletes it for 48 hours; Alchemy purges the
 * soft-deleted service right after deleting it so the same name can be
 * created again immediately.
 *
 * :::caution
 * Changing `name`, `location`, or `resourceGroup` replaces the service and
 * deletes every API, product, and subscription in it.
 *
 * The Consumption tier (the default) has no groups, users, notifications,
 * identity providers, developer portal content, or workspaces. Use
 * `BasicV2` or another tier for those. A Developer service takes 30-45
 * minutes to create.
 * :::
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-key-concepts
 *
 * ### Creating a Service
 * **Example:** Consumption (serverless) service
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * ```
 *
 * **Example:** BasicV2 service with a system-assigned identity
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   sku: { name: "BasicV2", capacity: 1 },
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * @resource
 */
export const Service = GroupedResource<Service>("Azure.ApiManagement.Service");

type ObservedService = apim.GetApiManagementServiceResponse;

const createServiceName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 50,
    lowercase: true,
  });
  const cleaned = name.replace(/[^a-z0-9-]/g, "-").replace(/-{2,}/g, "-");
  return /^[a-z]/.test(cleaned) ? cleaned : `a${cleaned.slice(0, 49)}`;
});

const skuFamily = (sku: string) => {
  const name = sku.toLowerCase();
  if (name === "consumption") return "consumption";
  if (name.endsWith("v2")) return "v2";
  return "classic";
};

/**
 * Consumption and v2 services usually provision in minutes but can queue
 * for 20+ when the region is busy; classic tiers take 30-45 minutes and
 * Premium can take over an hour.
 */
const budgetFor = (sku: string): WaitBudget =>
  skuFamily(sku) === "classic"
    ? { interval: "15 seconds", times: 360 }
    : { interval: "10 seconds", times: 180 };

const toAttrs = (
  resourceGroup: string,
  name: string,
  service: ObservedService,
): Service["Attributes"] => ({
  serviceName: name,
  serviceId: service.id ?? "",
  resourceGroup,
  location: service.location,
  sku: service.sku.name,
  capacity: service.sku.capacity,
  gatewayUrl: service.properties.gatewayUrl,
  portalUrl: service.properties.portalUrl,
  developerPortalUrl: service.properties.developerPortalUrl,
  managementApiUrl: service.properties.managementApiUrl,
  publicIPAddresses: [...(service.properties.publicIPAddresses ?? [])],
  principalId: service.identity?.principalId,
  tenantId: service.identity?.tenantId,
  tags: userTags(service.tags),
});

const toIdentityInput = (identity: ServiceIdentity): apim.ApiManagementServiceIdentityInput => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentities
    ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
    : undefined,
});

const identityDiffers = (
  observed: ObservedService["identity"],
  desired: ServiceIdentity | undefined,
) => {
  if (desired === undefined) return false;
  if ((observed?.type ?? "None") !== desired.type) return true;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? []).map((id) => id.toLowerCase()).sort();
  return have.join(",") !== want.join(",");
};

const getDeletedService = (subscriptionId: string, location: string, serviceName: string) =>
  orUndefinedIfNotFound(apim.GetDeletedServiceByName({ subscriptionId, location, serviceName }));

/**
 * Purge a soft-deleted service with this name so the name can be reused.
 * A no-op when nothing is soft-deleted.
 */
const purgeDeletedService = Effect.fn(function* (
  subscriptionId: string,
  displayLocation: string,
  serviceName: string,
) {
  // GET reports display names ("East US"); the deletedservices path wants "eastus".
  const location = displayLocation.replaceAll(" ", "").toLowerCase();
  // While the service delete is still finishing in the background, a purge
  // can be accepted without removing the soft-deleted record, so purge again
  // on every poll until the record is gone.
  const purgeOnce = Effect.gen(function* () {
    const deleted = yield* getDeletedService(subscriptionId, location, serviceName);
    if (deleted === undefined) return undefined;
    // The purge is refused while the delete is still transitioning; the
    // record stays, so the next poll purges again.
    yield* ignoreNotFound(apim.PurgeDeletedService({ subscriptionId, location, serviceName })).pipe(
      Effect.catchTag("ApiManagementServiceTransitioning", () => Effect.void),
    );
    return deleted;
  });
  yield* waitUntilGone(`soft-deleted API Management service ${serviceName}`, purgeOnce, {
    interval: "15 seconds",
    times: 40,
  });
});

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["serviceName", "serviceId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(apim.ListApiManagementService, { subscriptionId });
      return (page.value ?? []).flatMap((service) => {
        const group = resourceGroupOf(service.id);
        return hasAnyAlchemyTag(service.tags) && group !== undefined && service.name !== undefined
          ? [toAttrs(group, service.name, service)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.serviceName)) ||
        (news.location !== undefined &&
          !sameName(news.location.replaceAll(" ", ""), output.location.replaceAll(" ", ""))) ||
        skuFamily(news.sku?.name ?? "Consumption") !== skuFamily(output.sku)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.serviceName ?? olds?.name ?? (yield* createServiceName(id));
      const observed = yield* getService(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.serviceName ?? (yield* createServiceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const skuName = news.sku?.name ?? "Consumption";
      const sku = {
        name: skuName,
        capacity: news.sku?.capacity ?? (skuName === "Consumption" ? 0 : 1),
      };
      const budget = budgetFor(skuName);
      const where = { subscriptionId, resourceGroupName: resourceGroup };
      const get = getService(subscriptionId, resourceGroup, name);
      const label = `API Management service ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. A soft-deleted service with the same name blocks creation
      // for 48 hours, so purge it first.
      if (observed === undefined) {
        yield* purgeDeletedService(subscriptionId, location, name);
        yield* apim.ApiManagementServiceCreateOrUpdate({
          ...where,
          serviceName: name,
          location,
          sku,
          tags,
          identity: news.identity ? toIdentityInput(news.identity) : undefined,
          properties: {
            publisherEmail: news.publisherEmail,
            publisherName: news.publisherName,
            notificationSenderEmail: news.notificationSenderEmail,
            customProperties: news.customProperties,
            enableClientCertificate: news.enableClientCertificate,
            publicNetworkAccess: news.publicNetworkAccess,
            disableGateway: news.disableGateway,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (service) => service.properties.provisioningState,
        budget,
      );

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties;
      const changed: apim.ApiManagementServiceUpdatePropertiesInput = {};
      const scalar = {
        publisherEmail: news.publisherEmail,
        publisherName: news.publisherName,
        notificationSenderEmail: news.notificationSenderEmail,
        enableClientCertificate: news.enableClientCertificate,
        publicNetworkAccess: news.publicNetworkAccess,
        disableGateway: news.disableGateway,
      };
      for (const key of Object.keys(scalar) as (keyof typeof scalar)[]) {
        const value = scalar[key];
        if (value !== undefined && props[key] !== value) {
          Object.assign(changed, { [key]: value });
        }
      }
      if (
        news.customProperties !== undefined &&
        Object.entries(news.customProperties).some(
          ([key, value]) => props.customProperties?.[key]?.toLowerCase() !== value.toLowerCase(),
        )
      ) {
        changed.customProperties = {
          ...props.customProperties,
          ...news.customProperties,
        };
      }
      const skuChanged = observed.sku.name !== sku.name || observed.sku.capacity !== sku.capacity;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged || identityChanged) {
        yield* apim.UpdateApiManagementService({
          ...where,
          serviceName: name,
          sku: skuChanged ? sku : undefined,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged && news.identity ? toIdentityInput(news.identity) : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (service) => service.properties.provisioningState,
          budget,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.serviceName;
      // A service that is still activating or updating refuses the delete.
      yield* ignoreNotFound(
        apim.DeleteApiManagementService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: name,
        }),
      ).pipe(
        Effect.retry({
          while: (e) => e._tag === "ApiManagementServiceTransitioning",
          schedule: Schedule.spaced("15 seconds"),
          times: 120,
        }),
      );
      yield* waitUntilGone(
        `API Management service ${name}`,
        getService(subscriptionId, output.resourceGroup, name),
        budgetFor(output.sku),
      );
      // Deleting soft-deletes for 48 hours; purge so the name is free again.
      yield* purgeDeletedService(subscriptionId, output.location, name);
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
