import * as datamigration from "@distilled.cloud/azure/datamigration";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

/** Compute size of a classic migration service. */
export type ClassicMigrationServiceSku =
  | "Standard_1vCores"
  | "Standard_2vCores"
  | "Standard_4vCores"
  | "Premium_4vCores";

export interface ClassicMigrationServiceProps {
  /**
   * Resource group the service is created in. Changing it replaces the
   * service.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the service, 2-62 characters of letters, digits, `-`, `.` and
   * `_`. If omitted, a unique name is generated from the app, stage, and
   * logical ID.
   *
   * :::caution
   * Changing the name replaces the service.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the service. It must match the location of the
   * virtual network that holds `virtualSubnetId`.
   *
   * :::caution
   * Changing the location replaces the service.
   * :::
   *
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the `Microsoft.Network/virtualNetworks/subnets` subnet the
   * service joins. The service places one network interface in it and
   * reaches the source and target databases through it.
   *
   * :::caution
   * Changing the subnet replaces the service.
   * :::
   */
  virtualSubnetId: string;
  /**
   * Compute size. `Standard_*` sizes support offline migrations and are
   * free; `Premium_4vCores` supports online (minimal-downtime) migrations
   * and is billed per hour.
   *
   * :::caution
   * Changing the SKU replaces the service.
   * :::
   *
   * @default "Standard_1vCores"
   */
  sku?: ClassicMigrationServiceSku;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface ClassicMigrationService extends Resource<
  "Azure.DataMigration.ClassicMigrationService",
  ClassicMigrationServiceProps,
  {
    /** Name of the service. */
    serviceName: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** ARM resource ID of the service. */
    serviceId: string;
    /** Location of the service. */
    location: string;
    /** SKU name, e.g. `Standard_1vCores`. */
    sku: string;
    /** ARM ID of the subnet the service joined. */
    virtualSubnetId: string;
    /** ARM ID of the network interface Azure placed in the subnet. */
    virtualNicId: string | undefined;
    /** Public key the service uses to encrypt secrets sent to it. */
    publicKey: string | undefined;
    /**
     * Provisioning state reported by ARM: `Succeeded` once usable,
     * `Stopped` after the service is stopped.
     */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Database Migration Service (classic) instance
 * (`Microsoft.DataMigration/services`) — a VM-backed migration service
 * joined to one of your subnets that runs MySQL, PostgreSQL, and MongoDB
 * migration projects (`Azure.DataMigration.Project`). SQL Server
 * scenarios on the classic service are retired; use
 * `Azure.DataMigration.SqlMigrationService` for those.
 *
 * Standard sizes are free. Provisioning takes 10 minutes or more.
 *
 * :::caution
 * Changing `resourceGroup`, `name`, `location`, `virtualSubnetId`, or `sku`
 * replaces the service and deletes its projects.
 * :::
 *
 * See [Azure Database Migration Service](https://learn.microsoft.com/azure/dms/dms-overview).
 *
 * ### Creating a Classic Migration Service
 * **Example:** Service joined to a subnet
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("dms-vnet", {
 *   addressPrefixes: ["10.20.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("dms-subnet", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.20.1.0/24",
 * });
 * const dms = yield* Azure.DataMigration.ClassicMigrationService("dms", {
 *   virtualSubnetId: subnet.subnetId,
 * });
 * ```
 *
 * **Example:** Premium service for online migrations
 * ```typescript
 * const dms = yield* Azure.DataMigration.ClassicMigrationService("dms", {
 *   virtualSubnetId: subnet.subnetId,
 *   sku: "Premium_4vCores",
 *   tags: { team: "data" },
 * });
 * ```
 *
 * @resource
 */
export const ClassicMigrationService = GroupedResource<ClassicMigrationService>(
  "Azure.DataMigration.ClassicMigrationService",
);

type ObservedService = datamigration.GetServiceResponse;

const DEFAULT_SKU = "Standard_1vCores";

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 62, lowercase: true });

const skuTier = (sku: string) => sku.split("_")[0];

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const sameLocation = (a: string, b: string) =>
  a.replace(/\s/g, "").toLowerCase() === b.replace(/\s/g, "").toLowerCase();

const getService = (subscriptionId: string, groupName: string, serviceName: string) =>
  orUndefinedIfNotFound(datamigration.GetService({ subscriptionId, groupName, serviceName }));

/**
 * A stopped service is provisioned (it only needs `StartService`), and
 * `FailedToStart`/`FailedToStop` never recover on their own.
 */
const readiness = (service: ObservedService) => {
  const state = service.properties?.provisioningState;
  if (state === "Stopped") return "Succeeded";
  if (state === "FailedToStart" || state === "FailedToStop") return "Failed";
  return state;
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  service: ObservedService,
): ClassicMigrationService["Attributes"] => ({
  serviceName: name,
  resourceGroup,
  serviceId: service.id ?? "",
  location: service.location,
  sku: service.sku?.name ?? DEFAULT_SKU,
  virtualSubnetId: service.properties?.virtualSubnetId ?? "",
  virtualNicId: service.properties?.virtualNicId,
  publicKey: service.properties?.publicKey,
  provisioningState: service.properties?.provisioningState,
  tags: userTags(service.tags),
});

export const ClassicMigrationServiceProvider = () =>
  Provider.succeed(ClassicMigrationService, {
    stables: ["serviceName", "resourceGroup", "serviceId", "location", "virtualSubnetId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(datamigration.ListServices, { subscriptionId });
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
        (news.location !== undefined && !sameLocation(news.location, output.location)) ||
        !sameName(news.virtualSubnetId, output.virtualSubnetId) ||
        !sameName(news.sku ?? DEFAULT_SKU, output.sku)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.serviceName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getService(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataMigration");
      const groupName = news.resourceGroup;
      const name = news.name ?? output?.serviceName ?? (yield* physicalName(id));
      const location = news.location ?? output?.location ?? env.location;
      const sku = news.sku ?? DEFAULT_SKU;
      const tags = yield* desiredTags(id, news.tags);
      const get = getService(subscriptionId, groupName, name);
      // A classic service deploys a VM into the subnet; creation took more
      // than 10 minutes in eastus, so allow up to 25 minutes.
      const wait = () =>
        waitForProvisioned(`classic migration service ${name}`, get, readiness, {
          interval: "10 seconds",
          times: 150,
        });

      // Observe.
      let observed = yield* get;

      // Ensure: the PUT is a long-running operation; poll until deployed.
      if (observed === undefined) {
        yield* datamigration.ServicesCreateOrUpdate({
          subscriptionId,
          groupName,
          serviceName: name,
          location,
          sku: { name: sku, tier: skuTier(sku) },
          properties: { virtualSubnetId: news.virtualSubnetId },
          tags,
        });
        observed = yield* wait();
      } else if (readiness(observed) !== "Succeeded") {
        observed = yield* wait();
      }

      // Sync tags against observed cloud tags. Subnet, SKU, and location
      // replace the service (see diff), so tags are the only mutable aspect.
      if (tagsDiffer(observed.tags, tags)) {
        yield* datamigration.UpdateService({
          subscriptionId,
          groupName,
          serviceName: name,
          location: observed.location,
          tags,
        });
        observed = yield* wait();
      }

      return toAttrs(groupName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datamigration.DeleteService({
          subscriptionId,
          groupName: output.resourceGroup,
          serviceName: output.serviceName,
        }),
      );
      yield* waitUntilGone(
        `classic migration service ${output.serviceName}`,
        getService(subscriptionId, output.resourceGroup, output.serviceName),
        { interval: "10 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
