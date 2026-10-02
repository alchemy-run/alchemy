import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  createDnsName,
  fieldsMatch,
  lower,
  sameId,
  sameSecret,
  secretFingerprint,
  skuMatches,
  type SqlSku,
} from "./common.ts";

export interface ManagedInstanceProps {
  /** Resource group the instance is created in. Changing it replaces the instance. */
  resourceGroup: string;
  /**
   * Globally unique instance name: 1-63 lowercase letters, digits, and
   * hyphens. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the instance.
   */
  name?: string;
  /**
   * Azure location of the instance. Changing it replaces the instance.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of a subnet delegated to `Microsoft.Sql/managedInstances`.
   * Changing it replaces the instance.
   */
  subnetId: string;
  /**
   * SQL administrator login. Cannot be changed after creation, so changing
   * it replaces the instance.
   */
  administratorLogin: string;
  /**
   * SQL administrator password. Write-only: Alchemy stores a salted
   * fingerprint and only re-sends the password when it changes.
   */
  administratorLoginPassword: Redacted.Redacted<string>;
  /**
   * Instance SKU, e.g. `{ name: "GP_Gen5", tier: "GeneralPurpose", family: "Gen5" }`.
   * @default Azure's default (`GP_Gen5`)
   */
  sku?: SqlSku;
  /**
   * Number of vCores (4, 8, 16, …). Scaling takes hours.
   * @default Azure's default
   */
  vCores?: number;
  /**
   * Reserved storage in GB (multiple of 32).
   * @default Azure's default
   */
  storageSizeInGB?: number;
  /** License model (`LicenseIncluded` or Azure Hybrid Benefit `BasePrice`). */
  licenseType?: "LicenseIncluded" | "BasePrice";
  /**
   * Instance collation. Changing it replaces the instance.
   * @default "SQL_Latin1_General_CP1_CI_AS"
   */
  collation?: string;
  /**
   * Windows time zone ID, e.g. `UTC`. Changing it replaces the instance.
   * @default "UTC"
   */
  timezoneId?: string;
  /** Connection type: `Proxy`, `Redirect`, or `Default`. */
  proxyOverride?: "Proxy" | "Redirect" | "Default";
  /** Enable the public data endpoint (port 3342). */
  publicDataEndpointEnabled?: boolean;
  /** Minimum TLS version, e.g. `1.2`. */
  minimalTlsVersion?: string;
  /** Spread replicas across availability zones. */
  zoneRedundant?: boolean;
  /** Maintenance configuration ARM ID. */
  maintenanceConfigurationId?: string;
  /** Backup storage redundancy. */
  requestedBackupStorageRedundancy?: "Geo" | "Local" | "Zone" | "GeoZone";
  /**
   * Use the General Purpose v2 hardware generation. Changing it replaces
   * the instance.
   */
  isGeneralPurposeV2?: boolean;
  /**
   * ARM ID of a managed instance whose DNS zone this instance joins.
   * Required for the secondary of an `InstanceFailoverGroup`. Changing it
   * replaces the instance.
   */
  dnsZonePartner?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ManagedInstance extends Resource<
  "Azure.Sql.ManagedInstance",
  ManagedInstanceProps,
  {
    /** Name of the managed instance. */
    managedInstanceName: string;
    /** ARM resource ID of the managed instance. */
    managedInstanceId: string;
    /** Resource group that holds the instance. */
    resourceGroup: string;
    /** Location of the instance. */
    location: string;
    /** Private DNS name of the instance. */
    fullyQualifiedDomainName: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Instance state, e.g. `Ready`. */
    state: string | undefined;
    /** SQL administrator login. */
    administratorLogin: string | undefined;
    /** ARM ID of the subnet. */
    subnetId: string | undefined;
    /** Number of vCores. */
    vCores: number | undefined;
    /** Reserved storage in GB. */
    storageSizeInGB: number | undefined;
    /** DNS zone shared by instances in the same subnet. */
    dnsZone: string | undefined;
    /** Salted fingerprint of the last administrator password Alchemy set. */
    passwordFingerprint: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure SQL Managed Instance — a near-100% SQL Server compatible
 * instance deployed into a delegated virtual-network subnet.
 *
 * Provisioning the first instance in a subnet builds a virtual cluster and
 * can take several hours; scaling and deletion are similarly slow. The
 * minimum size is 4 vCores.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/sql-managed-instance-paas-overview
 *
 * ### Creating a Managed Instance
 * **Example:** General Purpose instance
 * ```typescript
 * const mi = yield* Azure.Sql.ManagedInstance("mi", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: miSubnetId,
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: Redacted.make(password),
 *   sku: { name: "GP_Gen5", tier: "GeneralPurpose", family: "Gen5" },
 *   vCores: 4,
 *   storageSizeInGB: 32,
 * });
 * ```
 *
 * ### Public Endpoint
 * **Example:** Enable the public data endpoint
 * ```typescript
 * const mi = yield* Azure.Sql.ManagedInstance("mi", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: miSubnetId,
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: Redacted.make(password),
 *   publicDataEndpointEnabled: true,
 *   proxyOverride: "Proxy",
 * });
 * ```
 *
 * @resource
 */
export const ManagedInstance = Resource<ManagedInstance>(
  "Azure.Sql.ManagedInstance",
);

type ObservedInstance = sql.GetManagedInstanceResponse;

const getInstance = (
  subscriptionId: string,
  resourceGroupName: string,
  managedInstanceName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetManagedInstance({
      subscriptionId,
      resourceGroupName,
      managedInstanceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  mi: ObservedInstance,
  passwordFingerprint: Redacted.Redacted<string> | undefined,
): ManagedInstance["Attributes"] => ({
  managedInstanceName: name,
  managedInstanceId: mi.id ?? "",
  resourceGroup,
  location: mi.location,
  fullyQualifiedDomainName: mi.properties?.fullyQualifiedDomainName,
  provisioningState: mi.properties?.provisioningState,
  state: mi.properties?.state,
  administratorLogin: mi.properties?.administratorLogin,
  subnetId: mi.properties?.subnetId,
  vCores: mi.properties?.vCores,
  storageSizeInGB: mi.properties?.storageSizeInGB,
  dnsZone: mi.properties?.dnsZone,
  passwordFingerprint,
  tags: userTags(mi.tags),
});

/** Managed instance operations run for hours: poll every minute for up to 6 h. */
const SLOW = { interval: "60 seconds", times: 360 } as const;

export const ManagedInstanceProvider = () =>
  Provider.succeed(ManagedInstance, {
    stables: [
      "managedInstanceName",
      "managedInstanceId",
      "resourceGroup",
      "location",
      "administratorLogin",
      "subnetId",
      "dnsZone",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* sql
        .ListManagedInstances({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListManagedInstances", page),
          ),
        );
      return (page.value ?? []).flatMap((mi) => {
        const group = resourceGroupOf(mi.id);
        return hasAnyAlchemyTag(mi.tags) &&
          group !== undefined &&
          mi.name !== undefined
          ? [toAttrs(group, mi.name, mi, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.managedInstanceName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (output.subnetId !== undefined &&
          !sameId(news.subnetId, output.subnetId)) ||
        (output.administratorLogin !== undefined &&
          news.administratorLogin !== output.administratorLogin) ||
        (olds !== undefined &&
          (news.collation !== olds.collation ||
            news.timezoneId !== olds.timezoneId ||
            news.isGeneralPurposeV2 !== olds.isGeneralPurposeV2 ||
            !sameId(news.dnsZonePartner, olds.dnsZonePartner)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.managedInstanceName ?? olds?.name ?? (yield* createDnsName(id));
      const observed = yield* getInstance(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        output?.passwordFingerprint,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.managedInstanceName ?? (yield* createDnsName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const fingerprint = yield* secretFingerprint(
        `${resourceGroup}/${name}`,
        news.administratorLoginPassword,
      );
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        managedInstanceName: name,
      };
      const get = getInstance(subscriptionId, resourceGroup, name);
      const waitReady = (
        converged: (mi: ObservedInstance) => boolean = () => true,
      ) =>
        waitForProvisioned(
          `sql managed instance ${name}`,
          get,
          (mi) =>
            converged(mi) ? mi.properties?.provisioningState : "Updating",
          SLOW,
        );
      const mutable = {
        vCores: news.vCores,
        storageSizeInGB: news.storageSizeInGB,
        licenseType: news.licenseType,
        proxyOverride: news.proxyOverride,
        publicDataEndpointEnabled: news.publicDataEndpointEnabled,
        minimalTlsVersion: news.minimalTlsVersion,
        zoneRedundant: news.zoneRedundant,
        maintenanceConfigurationId: news.maintenanceConfigurationId,
        requestedBackupStorageRedundancy: news.requestedBackupStorageRedundancy,
      };

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (hours for the first
      // instance in a subnet).
      let passwordSent = false;
      if (observed === undefined) {
        yield* sql.ManagedInstancesCreateOrUpdate({
          ...where,
          location,
          tags,
          sku: news.sku,
          properties: {
            ...mutable,
            subnetId: news.subnetId,
            administratorLogin: news.administratorLogin,
            administratorLoginPassword: news.administratorLoginPassword,
            collation: news.collation,
            timezoneId: news.timezoneId,
            isGeneralPurposeV2: news.isGeneralPurposeV2,
            dnsZonePartner: news.dnsZonePartner,
          },
        });
        passwordSent = true;
      }
      observed = yield* waitReady();

      // Sync mutable aspects against the observed instance.
      const props = observed.properties ?? {};
      const changed: sql.ManagedInstancePropertiesInput = {};
      for (const key of Object.keys(mutable) as (keyof typeof mutable)[]) {
        const value = mutable[key];
        if (value !== undefined && props[key] !== value) {
          Object.assign(changed, { [key]: value });
        }
      }
      if (
        !passwordSent &&
        !sameSecret(fingerprint, output?.passwordFingerprint)
      ) {
        changed.administratorLoginPassword = news.administratorLoginPassword;
      }
      const skuChanged =
        news.sku !== undefined && !skuMatches(observed.sku, news.sku);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged) {
        yield* sql.UpdateManagedInstance({
          ...where,
          sku: skuChanged ? news.sku : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitReady(
          (mi) =>
            fieldsMatch(mi.properties, changed, [
              "administratorLoginPassword",
            ]) &&
            (!skuChanged ||
              news.sku === undefined ||
              skuMatches(mi.sku, news.sku)) &&
            (!tagsChanged || !tagsDiffer(mi.tags, tags)),
        );
      }

      return toAttrs(resourceGroup, name, observed, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteManagedInstance({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          managedInstanceName: output.managedInstanceName,
        }),
      );
      yield* waitUntilGone(
        `sql managed instance ${output.managedInstanceName}`,
        getInstance(
          subscriptionId,
          output.resourceGroup,
          output.managedInstanceName,
        ),
        SLOW,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
