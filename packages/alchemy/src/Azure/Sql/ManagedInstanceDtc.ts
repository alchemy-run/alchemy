import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
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
import { fieldsMatch, isManagedInstanceOwnedByStack, lower } from "./common.ts";
import {
  instancePath,
  type InstanceScope,
  sameList,
  syncSetting,
} from "./setting.ts";

/** The setting is a singleton named `current`. */
const SETTING_NAME = "current";

/** Security settings of the managed instance's DTC. */
export interface ManagedInstanceDtcSecurity {
  /** Allow inbound DTC transactions. */
  allowInboundEnabled?: boolean;
  /** Allow outbound DTC transactions. */
  allowOutboundEnabled?: boolean;
  /** DTC authentication: `NoAuth`, `Incoming`, or `Mutual`. */
  authentication?: string;
  /** Allow XA transactions. */
  xaTransactionsEnabled?: boolean;
  /** Allow SNA LU 6.2 transactions. */
  snaLu6point2TransactionsEnabled?: boolean;
  /** Default timeout of XA transactions, in seconds. */
  xaTransactionsDefaultTimeout?: number;
  /** Maximum timeout of XA transactions, in seconds. */
  xaTransactionsMaximumTimeout?: number;
}

export interface ManagedInstanceDtcProps {
  /** Resource group of the managed instance. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the setting. */
  managedInstance: string;
  /** Whether the Distributed Transaction Coordinator is enabled. */
  dtcEnabled: boolean;
  /** DTC security settings. */
  security?: ManagedInstanceDtcSecurity;
  /** External DNS suffixes the DTC resolves. */
  externalDnsSuffixSearchList?: string[];
}

export interface ManagedInstanceDtc extends Resource<
  "Azure.Sql.ManagedInstanceDtc",
  ManagedInstanceDtcProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Whether DTC is enabled. */
    dtcEnabled: boolean;
    /** DNS suffix of the DTC host name. */
    dtcHostNameDnsSuffix: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The Distributed Transaction Coordinator (DTC) of an Azure SQL Managed
 * Instance — enables distributed transactions with SQL Server, other
 * instances, and DTC-aware applications.
 *
 * This is a singleton setting that always exists on an instance.
 * Destroying the resource disables DTC.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/distributed-transaction-coordinator-dtc
 *
 * ### Enabling DTC
 * **Example:** Allow inbound and outbound transactions
 * ```typescript
 * yield* Azure.Sql.ManagedInstanceDtc("dtc", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   dtcEnabled: true,
 *   security: { allowInboundEnabled: true, allowOutboundEnabled: true },
 * });
 * ```
 *
 * @resource
 */
export const ManagedInstanceDtc = Resource<ManagedInstanceDtc>(
  "Azure.Sql.ManagedInstanceDtc",
);

type Observed = sql.GetManagedInstanceDtcResponse;

const getSetting = (subscriptionId: string, scope: InstanceScope) =>
  orUndefinedIfNotFound(
    sql.GetManagedInstanceDtc({
      ...instancePath(subscriptionId, scope),
      dtcName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  observed: Observed,
): ManagedInstanceDtc["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  dtcEnabled: observed.properties?.dtcEnabled ?? false,
  dtcHostNameDnsSuffix: observed.properties?.dtcHostNameDnsSuffix,
});

export const ManagedInstanceDtcProvider = () =>
  Provider.succeed(ManagedInstanceDtc, {
    stables: ["settingId", "resourceGroup", "managedInstanceName"],

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
      const attrs = toAttrs(scope, observed);
      return output !== undefined ||
        (yield* isManagedInstanceOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.managedInstanceName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: InstanceScope = {
        resourceGroup: news.resourceGroup,
        managedInstanceName: news.managedInstance,
      };
      const desired = {
        dtcEnabled: news.dtcEnabled,
        externalDnsSuffixSearchList: news.externalDnsSuffixSearchList,
        securitySettings:
          news.security === undefined
            ? undefined
            : {
                transactionManagerCommunicationSettings: {
                  allowInboundEnabled: news.security.allowInboundEnabled,
                  allowOutboundEnabled: news.security.allowOutboundEnabled,
                  authentication: news.security.authentication,
                },
                xaTransactionsEnabled: news.security.xaTransactionsEnabled,
                snaLu6point2TransactionsEnabled:
                  news.security.snaLu6point2TransactionsEnabled,
                xaTransactionsDefaultTimeout:
                  news.security.xaTransactionsDefaultTimeout,
                xaTransactionsMaximumTimeout:
                  news.security.xaTransactionsMaximumTimeout,
              },
      };
      const fresh = yield* syncSetting({
        label: `sql managed instance dtc on ${scope.managedInstanceName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          fieldsMatch(observed.properties, desired, [
            "externalDnsSuffixSearchList",
          ]) &&
          sameList(
            observed.properties?.externalDnsSuffixSearchList,
            desired.externalDnsSuffixSearchList,
          ),
        put: sql.ManagedInstanceDtcsCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          dtcName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql managed instance dtc on ${output.managedInstanceName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The setting cannot be removed; disable DTC.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { dtcEnabled: false }),
          put: sql.ManagedInstanceDtcsCreateOrUpdate({
            ...instancePath(subscriptionId, output),
            dtcName: SETTING_NAME,
            properties: { dtcEnabled: false },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
