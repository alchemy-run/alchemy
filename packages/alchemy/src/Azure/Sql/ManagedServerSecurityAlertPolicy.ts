import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldsMatch,
  isManagedInstanceOwnedByStack,
  lower,
  sameSecret,
} from "./common.ts";
import {
  instancePath,
  type InstanceScope,
  sameList,
  secretsFingerprint,
  syncSetting,
} from "./setting.ts";

/** The policy is a singleton named `Default`. */
const SETTING_NAME = "Default";

export interface ManagedServerSecurityAlertPolicyProps {
  /** Resource group of the managed instance. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the policy. */
  managedInstance: string;
  /** Whether threat detection alerts are enabled. */
  state: "Enabled" | "Disabled";
  /**
   * Alerts to disable: `Sql_Injection`, `Sql_Injection_Vulnerability`,
   * `Access_Anomaly`, `Data_Exfiltration`, `Unsafe_Action`, `Brute_Force`.
   */
  disabledAlerts?: string[];
  /** Email addresses alerts are sent to. */
  emailAddresses?: string[];
  /** Also email the subscription administrators. */
  emailAccountAdmins?: boolean;
  /** Blob endpoint of the storage account that holds threat detection audit logs. */
  storageEndpoint?: string;
  /** Days to keep threat detection audit logs. */
  retentionDays?: number;
  /**
   * Access key of the storage account. Omit it when the managed identity is used. Write-only: Alchemy stores a salted fingerprint and only
   * re-sends it when it changes.
   */
  storageAccountAccessKey?: Redacted.Redacted<string>;
}

export interface ManagedServerSecurityAlertPolicy extends Resource<
  "Azure.Sql.ManagedServerSecurityAlertPolicy",
  ManagedServerSecurityAlertPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Whether alerts are enabled. */
    state: string;
    /** Disabled alerts. */
    disabledAlerts: string[];
    /** Alert recipients. */
    emailAddresses: string[];
    /** Whether subscription administrators are emailed. */
    emailAccountAdmins: boolean | undefined;
    /** Salted fingerprint of the write-only secrets Alchemy last set. */
    secretFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * Threat detection alerts for an Azure SQL Managed Instance — emails a notice when
 * Microsoft Defender for SQL detects anomalous activity (SQL injection,
 * brute-force logins, unusual access).
 *
 * This is a singleton setting that always exists on its parent.
 * Destroying the resource disables the alerts again.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/threat-detection-configure
 *
 * ### Enabling Alerts
 * **Example:** Email security alerts
 * ```typescript
 * yield* Azure.Sql.ManagedServerSecurityAlertPolicy("alerts", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   state: "Enabled",
 *   emailAddresses: ["security@example.com"],
 * });
 * ```
 *
 * @resource
 */
export const ManagedServerSecurityAlertPolicy =
  Resource<ManagedServerSecurityAlertPolicy>(
    "Azure.Sql.ManagedServerSecurityAlertPolicy",
  );

type Observed = sql.GetManagedServerSecurityAlertPolicyResponse;

const getSetting = (subscriptionId: string, scope: InstanceScope) =>
  orUndefinedIfNotFound(
    sql.GetManagedServerSecurityAlertPolicy({
      ...instancePath(subscriptionId, scope),
      securityAlertPolicyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  observed: Observed,
  fingerprint: Redacted.Redacted<string> | undefined,
): ManagedServerSecurityAlertPolicy["Attributes"] => ({
  policyId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  state: observed.properties?.state ?? "Disabled",
  disabledAlerts: [...(observed.properties?.disabledAlerts ?? [])].filter(
    (a) => a !== "",
  ),
  emailAddresses: [...(observed.properties?.emailAddresses ?? [])].filter(
    (a) => a !== "",
  ),
  emailAccountAdmins: observed.properties?.emailAccountAdmins,
  secretFingerprint: fingerprint,
});

export const ManagedServerSecurityAlertPolicyProvider = () =>
  Provider.succeed(ManagedServerSecurityAlertPolicy, {
    stables: ["policyId", "resourceGroup", "managedInstanceName"],

    // A singleton setting of its managed instance; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstanceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedInstanceName =
        output?.managedInstanceName ?? olds?.managedInstance;
      if (resourceGroup === undefined || managedInstanceName === undefined) {
        return undefined;
      }
      const scope = { resourceGroup, managedInstanceName };
      const observed = yield* getSetting(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed, output?.secretFingerprint);
      return output !== undefined ||
        (yield* isManagedInstanceOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.managedInstanceName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: InstanceScope = {
        resourceGroup: news.resourceGroup,
        managedInstanceName: news.managedInstance,
      };
      const fingerprint = yield* secretsFingerprint(
        `${scope.resourceGroup}/${scope.managedInstanceName}/ManagedServerSecurityAlertPolicy`,
        [news.storageAccountAccessKey],
      );
      const desired = {
        state: news.state,
        disabledAlerts: news.disabledAlerts,
        emailAddresses: news.emailAddresses,
        emailAccountAdmins: news.emailAccountAdmins,
        storageEndpoint: news.storageEndpoint,
        retentionDays: news.retentionDays,
      };
      const fresh = yield* syncSetting({
        label: `sql an Azure SQL Managed Instance security alert policy on ${scope.managedInstanceName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          fieldsMatch(observed.properties, desired, [
            "disabledAlerts",
            "emailAddresses",
          ]) &&
          sameList(
            observed.properties?.disabledAlerts?.filter((a) => a !== ""),
            desired.disabledAlerts,
          ) &&
          sameList(
            observed.properties?.emailAddresses?.filter((a) => a !== ""),
            desired.emailAddresses,
          ),
        put: sql.ManagedServerSecurityAlertPoliciesCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          securityAlertPolicyName: SETTING_NAME,
          properties: {
            ...desired,
            storageAccountAccessKey:
              news.storageAccountAccessKey === undefined
                ? undefined
                : Redacted.value(news.storageAccountAccessKey),
          },
        }),
        force:
          [news.storageAccountAccessKey].some(
            (secret) => secret !== undefined,
          ) && !sameSecret(fingerprint, output?.secretFingerprint),
      });
      return toAttrs(scope, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql an Azure SQL Managed Instance security alert policy on ${output.managedInstanceName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The policy cannot be removed; disable it.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { state: "Disabled" }),
          put: sql.ManagedServerSecurityAlertPoliciesCreateOrUpdate({
            ...instancePath(subscriptionId, output),
            securityAlertPolicyName: SETTING_NAME,
            properties: { state: "Disabled" },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
