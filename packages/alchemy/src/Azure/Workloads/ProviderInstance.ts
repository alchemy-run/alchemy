import * as workloads from "@distilled.cloud/azure/workloads";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  identityBlock,
  identityIds,
  lower,
  monitorOwnedByStage,
  withRecordedError,
} from "./Common.ts";

/** How the monitor validates TLS when it connects to the provider. */
export type ProviderSslPreference =
  | "Disabled"
  | "RootCertificate"
  | "ServerCertificate";

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
  providerType: "PrometheusOS";
  /** URL of the node exporter, e.g. `http://10.0.0.4:9100/metrics`. */
  prometheusUrl: string;
  /** SID of the SAP system the host belongs to. */
  sapSid?: string;
}

/** Pacemaker cluster metrics from a Prometheus `ha_cluster_exporter`. */
export interface PrometheusHaClusterProviderSettings extends ProviderTls {
  providerType: "PrometheusHaCluster";
  /** URL of the HA cluster exporter, e.g. `http://10.0.0.4:9664/metrics`. */
  prometheusUrl: string;
  /** Host name of the cluster node. */
  hostname?: string;
  /** SID of the cluster. */
  sid?: string;
  /** Name of the cluster. */
  clusterName?: string;
}

/** SAP HANA database metrics. */
export interface SapHanaProviderSettings extends ProviderTls {
  providerType: "SapHana";
  /** Host name or IP address of the HANA instance. */
  hostname: string;
  /** Database (tenant) name. */
  dbName?: string;
  /** SQL port of the database. */
  sqlPort?: string;
  /** HANA instance number. */
  instanceNumber?: string;
  /** Database user name. */
  dbUsername?: string;
  /** Database password. Prefer `dbPasswordUri` (a Key Vault secret). */
  dbPassword?: Redacted.Redacted<string>;
  /** Key Vault secret URI of the database password. */
  dbPasswordUri?: string;
  /** Host name in the server's TLS certificate. */
  sslHostNameInCertificate?: string;
  /** SID of the SAP system. */
  sapSid?: string;
}

/** SAP NetWeaver application server metrics (SAP Control web service). */
export interface SapNetWeaverProviderSettings extends ProviderTls {
  providerType: "SapNetWeaver";
  /** SID of the SAP system. */
  sapSid?: string;
  /** Host name or IP address of the application server. */
  sapHostname: string;
  /** Instance number of the application server. */
  sapInstanceNr?: string;
  /** `/etc/hosts`-style entries (`ip fqdn hostname`) for every instance. */
  sapHostFileEntries?: string[];
  /** SAP user name. */
  sapUsername?: string;
  /** SAP password. Prefer `sapPasswordUri` (a Key Vault secret). */
  sapPassword?: Redacted.Redacted<string>;
  /** Key Vault secret URI of the SAP password. */
  sapPasswordUri?: string;
  /** SAP client ID. */
  sapClientId?: string;
  /** SAP HTTP port number. */
  sapPortNumber?: string;
}

/** Microsoft SQL Server metrics. */
export interface MsSqlServerProviderSettings extends ProviderTls {
  providerType: "MsSqlServer";
  /** Host name or IP address of the SQL Server. */
  hostname: string;
  /** SQL Server port. */
  dbPort?: string;
  /** Database user name. */
  dbUsername?: string;
  /** Database password. Prefer `dbPasswordUri` (a Key Vault secret). */
  dbPassword?: Redacted.Redacted<string>;
  /** Key Vault secret URI of the database password. */
  dbPasswordUri?: string;
  /** SID of the SAP system. */
  sapSid?: string;
}

/** IBM Db2 metrics. */
export interface Db2ProviderSettings extends ProviderTls {
  providerType: "Db2";
  /** Host name or IP address of the Db2 server. */
  hostname: string;
  /** Database name. */
  dbName?: string;
  /** Database port. */
  dbPort?: string;
  /** Database user name. */
  dbUsername?: string;
  /** Database password. Prefer `dbPasswordUri` (a Key Vault secret). */
  dbPassword?: Redacted.Redacted<string>;
  /** Key Vault secret URI of the database password. */
  dbPasswordUri?: string;
  /** SID of the SAP system. */
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
   */
  resourceGroup: string;
  /** Name of the parent monitor. Changing it replaces the provider instance. */
  monitor: string;
  /**
   * Provider instance name, 2-20 characters. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * provider instance.
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
 * A provider instance of an Azure Monitor for SAP solutions
 * {@link Monitor}: one SAP HANA, NetWeaver, SQL Server, Db2, or Prometheus
 * endpoint the monitor collects telemetry from. The endpoint must be
 * reachable from the monitor's subnet; Azure validates connectivity when
 * the instance is created.
 *
 * @see https://learn.microsoft.com/azure/sap/monitor/provider-linux
 *
 * ### Operating-System Metrics
 * **Example:** Prometheus node exporter on a SAP host
 * ```typescript
 * const os = yield* Azure.Workloads.ProviderInstance("os", {
 *   resourceGroup: group.resourceGroupName,
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
 *   resourceGroup: group.resourceGroupName,
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
export const ProviderInstance = Resource<ProviderInstance>(
  "Azure.Workloads.ProviderInstance",
);

type ObservedInstance = workloads.GetProviderInstanceResponse;

const SECRET_FIELDS = ["dbPassword", "sapPassword"] as const;

/** Wire form of the settings (secrets unwrapped). */
const toWire = (
  settings: ProviderInstanceSettings,
): workloads.ProviderSpecificProperties => {
  const wire: Record<string, unknown> = { ...settings };
  for (const field of SECRET_FIELDS) {
    const value = wire[field];
    if (Redacted.isRedacted(value)) wire[field] = Redacted.value(value);
  }
  return wire as unknown as workloads.ProviderSpecificProperties;
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
const settingsDrift = (
  observed: object | undefined,
  desired: ProviderInstanceSettings,
) => {
  const seen = (observed ?? {}) as Record<string, unknown>;
  return Object.entries(desired).some(
    ([key, value]) =>
      value !== undefined &&
      !(SECRET_FIELDS as readonly string[]).includes(key) &&
      JSON.stringify(seen[key]) !== JSON.stringify(value),
  );
};

/** Fingerprint of the secrets, so a password change also re-creates. */
const secretFingerprint = (settings: ProviderInstanceSettings) =>
  JSON.stringify(
    SECRET_FIELDS.map((field) => {
      const value = (settings as unknown as Record<string, unknown>)[field];
      return Redacted.isRedacted(value) ? Redacted.value(value) : value;
    }),
  );

// Provider instance names are 2-20 characters long.
const createInstanceName = (id: string) =>
  createPhysicalName({ id, maxLength: 20 });

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
    stables: [
      "providerInstanceName",
      "providerInstanceId",
      "resourceGroup",
      "monitor",
    ],

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
          (fingerprint(news.providerSettings) !==
            fingerprint(olds.providerSettings) ||
            secretFingerprint(news.providerSettings) !==
              secretFingerprint(olds.providerSettings) ||
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
      const name =
        output?.providerInstanceName ??
        olds?.name ??
        (yield* createInstanceName(id));
      const observed = yield* getInstance(
        subscriptionId,
        resourceGroup,
        monitor,
        name,
      );
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
      const name =
        news.name ??
        output?.providerInstanceName ??
        (yield* createInstanceName(id));
      const get = getInstance(subscriptionId, resourceGroup, monitor, name);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. There is no PATCH: a missing, failed, or drifted
      // instance (non-secret settings) is (re-)submitted with a full PUT.
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed" ||
        settingsDrift(
          observed.properties?.providerSettings,
          news.providerSettings,
        ) ||
        identityIds(
          Object.keys(observed.identity?.userAssignedIdentities ?? {}),
        ).join(",") !== identityIds(news.userAssignedIdentityIds).join(",")
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
