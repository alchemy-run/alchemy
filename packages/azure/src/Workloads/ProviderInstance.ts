import * as workloads from "@distilled.cloud/azure/workloads";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  identityBlock,
  identityIds,
  lower,
  monitorOwnedByStage,
  withRecordedError,
} from "./Common.ts";

/** How the monitor validates TLS when it connects to the provider. */
export type ProviderSslPreference = "Disabled" | "RootCertificate" | "ServerCertificate";

interface ProviderTls {
  /**
   * TLS mode used to reach the endpoint.
   * @default "Disabled"
   */
  sslPreference?: ProviderSslPreference;
  /** Blob URI of the certificate, for `RootCertificate` / `ServerCertificate`. */
  sslCertificateUri?: string;
}

/** Linux OS metrics from a Prometheus `node_exporter`. */
export interface PrometheusOsProviderSettings extends ProviderTls {
  /** Provider type: Prometheus node exporter on an OS host. */
  providerType: "PrometheusOS";
  /** URL of the node exporter, e.g. `http://10.0.0.4:9100/metrics`. */
  prometheusUrl: string;
  /**
   * SID of the SAP system the host belongs to.
   * @default not set
   */
  sapSid?: string;
}

/** Pacemaker cluster metrics from a Prometheus `ha_cluster_exporter`. */
export interface PrometheusHaClusterProviderSettings extends ProviderTls {
  /** Provider type: Prometheus HA cluster exporter. */
  providerType: "PrometheusHaCluster";
  /** URL of the HA cluster exporter, e.g. `http://10.0.0.4:9664/metrics`. */
  prometheusUrl: string;
  /**
   * Host name of the cluster node.
   * @default not set
   */
  hostname?: string;
  /**
   * SID of the cluster.
   * @default not set
   */
  sid?: string;
  /**
   * Name of the cluster.
   * @default not set
   */
  clusterName?: string;
}

/** SAP HANA database metrics. */
export interface SapHanaProviderSettings extends ProviderTls {
  /** Provider type: SAP HANA database. */
  providerType: "SapHana";
  /** Host name or IP address of the HANA instance. */
  hostname: string;
  /**
   * Database (tenant) name.
   * @default not set
   */
  dbName?: string;
  /**
   * SQL port of the database.
   * @default not set
   */
  sqlPort?: string;
  /**
   * HANA instance number.
   * @default not set
   */
  instanceNumber?: string;
  /**
   * Database user name.
   * @default not set
   */
  dbUsername?: string;
  /**
   * Database password. Prefer `dbPasswordUri` (a Key Vault secret).
   * @default not set
   */
  dbPassword?: Redacted.Redacted<string>;
  /**
   * Key Vault secret URI of the database password.
   * @default not set
   */
  dbPasswordUri?: string;
  /**
   * Host name in the server's TLS certificate.
   * @default not set
   */
  sslHostNameInCertificate?: string;
  /**
   * SID of the SAP system.
   * @default not set
   */
  sapSid?: string;
}

/** SAP NetWeaver application server metrics (SAP Control web service). */
export interface SapNetWeaverProviderSettings extends ProviderTls {
  /** Provider type: SAP NetWeaver application server. */
  providerType: "SapNetWeaver";
  /**
   * SID of the SAP system.
   * @default not set
   */
  sapSid?: string;
  /** Host name or IP address of the application server. */
  sapHostname: string;
  /**
   * Instance number of the application server.
   * @default not set
   */
  sapInstanceNr?: string;
  /**
   * `/etc/hosts`-style entries (`ip fqdn hostname`) for every instance.
   * @default not set
   */
  sapHostFileEntries?: string[];
  /**
   * SAP user name.
   * @default not set
   */
  sapUsername?: string;
  /**
   * SAP password. Prefer `sapPasswordUri` (a Key Vault secret).
   * @default not set
   */
  sapPassword?: Redacted.Redacted<string>;
  /**
   * Key Vault secret URI of the SAP password.
   * @default not set
   */
  sapPasswordUri?: string;
  /**
   * SAP client ID.
   * @default not set
   */
  sapClientId?: string;
  /**
   * SAP HTTP port number.
   * @default not set
   */
  sapPortNumber?: string;
}

/** Microsoft SQL Server metrics. */
export interface MsSqlServerProviderSettings extends ProviderTls {
  /** Provider type: Microsoft SQL Server database. */
  providerType: "MsSqlServer";
  /** Host name or IP address of the SQL Server. */
  hostname: string;
  /**
   * SQL Server port.
   * @default not set
   */
  dbPort?: string;
  /**
   * Database user name.
   * @default not set
   */
  dbUsername?: string;
  /**
   * Database password. Prefer `dbPasswordUri` (a Key Vault secret).
   * @default not set
   */
  dbPassword?: Redacted.Redacted<string>;
  /**
   * Key Vault secret URI of the database password.
   * @default not set
   */
  dbPasswordUri?: string;
  /**
   * SID of the SAP system.
   * @default not set
   */
  sapSid?: string;
}

/** IBM Db2 metrics. */
export interface Db2ProviderSettings extends ProviderTls {
  /** Provider type: IBM Db2 database. */
  providerType: "Db2";
  /** Host name or IP address of the Db2 server. */
  hostname: string;
  /**
   * Database name.
   * @default not set
   */
  dbName?: string;
  /**
   * Database port.
   * @default not set
   */
  dbPort?: string;
  /**
   * Database user name.
   * @default not set
   */
  dbUsername?: string;
  /**
   * Database password. Prefer `dbPasswordUri` (a Key Vault secret).
   * @default not set
   */
  dbPassword?: Redacted.Redacted<string>;
  /**
   * Key Vault secret URI of the database password.
   * @default not set
   */
  dbPasswordUri?: string;
  /**
   * SID of the SAP system.
   * @default not set
   */
  sapSid?: string;
}

/** Endpoint-specific settings of a provider instance, keyed by `providerType`. */
export type ProviderInstanceSettings =
  | PrometheusOsProviderSettings
  | PrometheusHaClusterProviderSettings
  | SapHanaProviderSettings
  | SapNetWeaverProviderSettings
  | MsSqlServerProviderSettings
  | Db2ProviderSettings;

export interface ProviderInstanceProps {
  /**
   * Resource group of the monitor. Changing it replaces the provider
   * instance.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the parent monitor. Changing it replaces the provider instance. */
  monitor: string;
  /**
   * Provider instance name, 2-20 characters. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * provider instance.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Endpoint the monitor collects from. Any change re-creates the provider
   * instance (Azure has no in-place update; the PUT re-validates
   * connectivity).
   */
  providerSettings: ProviderInstanceSettings;
  /**
   * ARM IDs of pre-created user-assigned identities used to read secrets.
   * Changing them replaces the provider instance.
   * @default no identity
   */
  userAssignedIdentityIds?: string[];
}

export interface ProviderInstance extends Resource<
  "Azure.Workloads.ProviderInstance",
  ProviderInstanceProps,
  {
    /** Name of the provider instance. */
    providerInstanceName: string;
    /** ARM resource ID of the provider instance. */
    providerInstanceId: string;
    /** Resource group of the monitor. */
    resourceGroup: string;
    /** Name of the parent monitor. */
    monitor: string;
    /** Provider type, e.g. `PrometheusOS` or `SapHana`. */
    providerType: string;
    /** Provisioning state of the provider instance. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A provider instance of an Azure Monitor for SAP solutions {@link Monitor}
 * (`Microsoft.Workloads/monitors/providerInstances`): one SAP HANA,
 * NetWeaver, SQL Server, Db2, or Prometheus endpoint the monitor collects
 * telemetry from. The endpoint must be reachable from the monitor's subnet;
 * Azure validates connectivity when the instance is created.
 *
 * :::caution
 * Changing `monitor`, `name`, `providerSettings`, `userAssignedIdentityIds`,
 * or `resourceGroup` replaces the provider instance. Azure has no update, so
 * any settings change replaces it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/sap/monitor/provider-linux
 *
 * ### Operating-System Metrics
 * **Example:** Prometheus node exporter on a SAP host
 * ```typescript
 * const monitor = yield* Azure.Workloads.Monitor("ams", {
 *   monitorSubnet:
 *     "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/sap/providers/Microsoft.Network/virtualNetworks/sap-vnet/subnets/ams",
 * });
 * const os = yield* Azure.Workloads.ProviderInstance("os", {
 *   monitor: monitor.monitorName,
 *   providerSettings: {
 *     providerType: "PrometheusOS",
 *     prometheusUrl: "http://10.0.0.4:9100/metrics",
 *     sapSid: "S4H",
 *   },
 * });
 * ```
 *
 * ### Database Metrics
 * **Example:** SAP HANA with a Key Vault password
 * ```typescript
 * const hana = yield* Azure.Workloads.ProviderInstance("hana", {
 *   monitor: monitor.monitorName,
 *   providerSettings: {
 *     providerType: "SapHana",
 *     hostname: "10.0.0.5",
 *     dbName: "SYSTEMDB",
 *     sqlPort: "30013",
 *     instanceNumber: "00",
 *     dbUsername: "AMS_MONITOR",
 *     dbPasswordUri: secret.secretUri,
 *     sapSid: "S4H",
 *   },
 *   userAssignedIdentityIds: [identity.identityId],
 * });
 * ```
 *
 * @resource
 */
export const ProviderInstance = GroupedResource<ProviderInstance>(
  "Azure.Workloads.ProviderInstance",
);

type ObservedInstance = workloads.GetProviderInstanceResponse;

const SECRET_FIELDS = ["dbPassword", "sapPassword"] as const;

/** The secrets of the settings, unwrapped. */
const secretsOf = (settings: ProviderInstanceSettings) => ({
  dbPassword:
    "dbPassword" in settings && settings.dbPassword !== undefined
      ? Redacted.value(settings.dbPassword)
      : undefined,
  sapPassword:
    "sapPassword" in settings && settings.sapPassword !== undefined
      ? Redacted.value(settings.sapPassword)
      : undefined,
});

/** Wire form of the settings (secrets unwrapped). */
const toWire = (settings: ProviderInstanceSettings): workloads.ProviderSpecificProperties => {
  const { dbPassword, sapPassword } = secretsOf(settings);
  const wire: workloads.ProviderSpecificProperties = { ...settings, dbPassword, sapPassword };
  if (dbPassword === undefined) delete wire.dbPassword;
  if (sapPassword === undefined) delete wire.sapPassword;
  return wire;
};

/**
 * Canonical non-secret settings, for comparing desired with observed or
 * previous settings. Azure never returns passwords.
 */
const fingerprint = (settings: object | undefined) => {
  if (settings === undefined) return "";
  const entries = Object.entries(settings)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        value !== null &&
        !(SECRET_FIELDS as readonly string[]).includes(key),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
};

/**
 * Whether observed settings differ from the desired ones in any field the
 * user set (server-side defaults the user left out are ignored).
 */
const settingsDrift = (observed: object | undefined, desired: ProviderInstanceSettings) => {
  const seen = (observed ?? {}) as Record<string, unknown>;
  return Object.entries(desired).some(
    ([key, value]) =>
      value !== undefined &&
      !(SECRET_FIELDS as readonly string[]).includes(key) &&
      JSON.stringify(seen[key]) !== JSON.stringify(value),
  );
};

/** Fingerprint of the secrets, so a password change also re-creates. */
const secretFingerprint = (settings: ProviderInstanceSettings) => {
  const secrets = secretsOf(settings);
  return JSON.stringify(SECRET_FIELDS.map((field) => secrets[field]));
};

// Provider instance names are 2-20 characters long.
const createInstanceName = (id: string) => createPhysicalName({ id, maxLength: 20 });

const getInstance = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
  providerInstanceName: string,
) =>
  orUndefinedIfNotFound(
    workloads.GetProviderInstance({
      subscriptionId,
      resourceGroupName,
      monitorName,
      providerInstanceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  monitor: string,
  name: string,
  instance: ObservedInstance,
): ProviderInstance["Attributes"] => ({
  providerInstanceName: name,
  providerInstanceId: instance.id ?? "",
  resourceGroup,
  monitor,
  providerType: instance.properties?.providerSettings?.providerType ?? "",
  provisioningState: instance.properties?.provisioningState,
});

const describeErrors = (instance: ObservedInstance | undefined) => {
  const errors = instance?.properties?.errors;
  if (errors === undefined) return undefined;
  return [errors.code, errors.message].filter(Boolean).join(": ");
};

export const ProviderInstanceProvider = () =>
  Provider.succeed(ProviderInstance, {
    stables: ["providerInstanceName", "providerInstanceId", "resourceGroup", "monitor"],

    // Provider instances vanish with their monitor.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.monitor) !== lower(output.monitor) ||
        (news.name !== undefined && news.name !== output.providerInstanceName) ||
        news.providerSettings.providerType !== output.providerType ||
        (olds !== undefined &&
          (fingerprint(news.providerSettings) !== fingerprint(olds.providerSettings) ||
            secretFingerprint(news.providerSettings) !== secretFingerprint(olds.providerSettings) ||
            identityIds(news.userAssignedIdentityIds).join(",") !==
              identityIds(olds.userAssignedIdentityIds).join(",")))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const monitor = output?.monitor ?? olds?.monitor;
      if (resourceGroup === undefined || monitor === undefined) {
        return undefined;
      }
      const name = output?.providerInstanceName ?? olds?.name ?? (yield* createInstanceName(id));
      const observed = yield* getInstance(subscriptionId, resourceGroup, monitor, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, monitor, name, observed);
      return (yield* monitorOwnedByStage(subscriptionId, resourceGroup, monitor))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Workloads");
      const { resourceGroup, monitor } = news;
      const name = news.name ?? output?.providerInstanceName ?? (yield* createInstanceName(id));
      const get = getInstance(subscriptionId, resourceGroup, monitor, name);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. There is no PATCH: a missing, failed, or drifted
      // instance (non-secret settings) is (re-)submitted with a full PUT.
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed" ||
        settingsDrift(observed.properties?.providerSettings, news.providerSettings) ||
        identityIds(Object.keys(observed.identity?.userAssignedIdentities ?? {})).join(",") !==
          identityIds(news.userAssignedIdentityIds).join(",")
      ) {
        yield* workloads.CreateProviderInstance({
          subscriptionId,
          resourceGroupName: resourceGroup,
          monitorName: monitor,
          providerInstanceName: name,
          identity: news.userAssignedIdentityIds?.length
            ? identityBlock(news.userAssignedIdentityIds)
            : undefined,
          properties: { providerSettings: toWire(news.providerSettings) },
        });
      }
      // Creation validates connectivity from the monitor's subnet.
      observed = yield* waitForProvisioned(
        `SAP monitor provider instance ${name}`,
        get,
        (instance) => instance.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      ).pipe(withRecordedError(Effect.map(get, describeErrors)));

      return toAttrs(resourceGroup, monitor, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        workloads.DeleteProviderInstance({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          monitorName: output.monitor,
          providerInstanceName: output.providerInstanceName,
        }),
      );
      yield* waitUntilGone(
        `SAP monitor provider instance ${output.providerInstanceName}`,
        getInstance(
          subscriptionId,
          output.resourceGroup,
          output.monitor,
          output.providerInstanceName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Workloads.Monitor"],
    },
  });
