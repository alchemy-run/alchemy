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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { fieldsMatch, isManagedInstanceOwnedByStack, lower } from "./common.ts";
import { instancePath, type InstanceScope, syncSetting } from "./setting.ts";

/** The administrator is a singleton named `ActiveDirectory`. */
const SETTING_NAME = "ActiveDirectory";

export interface ManagedInstanceAdministratorProps {
  /** Resource group of the managed instance. Changing it replaces the administrator. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the administrator. */
  managedInstance: string;
  /**
   * Display name of the Microsoft Entra user, group, or application. The
   * instance rejects very long names (e.g. 128-character generated managed
   * identity names) as invalid logins. The instance's identity must hold
   * the Entra "Directory Readers" role to resolve the administrator.
   */
  login: string;
  /** Object ID (user/group) or application ID of the administrator. */
  sid: string;
  /**
   * Entra tenant of the administrator.
   * @default the subscription's tenant
   */
  tenantId?: string;
}

export interface ManagedInstanceAdministrator extends Resource<
  "Azure.Sql.ManagedInstanceAdministrator",
  ManagedInstanceAdministratorProps,
  {
    /** ARM resource ID of the administrator. */
    administratorId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Display name of the administrator. */
    login: string;
    /** Object or application ID of the administrator. */
    sid: string;
    /** Tenant of the administrator. */
    tenantId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The Microsoft Entra administrator of an Azure SQL Managed Instance. The
 * instance needs a managed identity with Directory Readers access to
 * resolve Entra principals.
 *
 * Destroying the resource removes the administrator.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/authentication-aad-configure
 *
 * ### Setting the Administrator
 * **Example:** Make a group the Entra administrator
 * ```typescript
 * yield* Azure.Sql.ManagedInstanceAdministrator("entra-admin", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   login: "sql-admins",
 *   sid: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * @resource
 */
export const ManagedInstanceAdministrator =
  Resource<ManagedInstanceAdministrator>(
    "Azure.Sql.ManagedInstanceAdministrator",
  );

type Observed = sql.GetManagedInstanceAdministratorResponse;

const getSetting = (subscriptionId: string, scope: InstanceScope) =>
  orUndefinedIfNotFound(
    sql.GetManagedInstanceAdministrator({
      ...instancePath(subscriptionId, scope),
      administratorName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  observed: Observed,
): ManagedInstanceAdministrator["Attributes"] => ({
  administratorId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  login: observed.properties?.login ?? "",
  sid: observed.properties?.sid ?? "",
  tenantId: observed.properties?.tenantId,
});

export const ManagedInstanceAdministratorProvider = () =>
  Provider.succeed(ManagedInstanceAdministrator, {
    stables: ["administratorId", "resourceGroup", "managedInstanceName"],

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
        administratorType: "ActiveDirectory",
        login: news.login,
        sid: news.sid,
        tenantId: news.tenantId,
      };
      const fresh = yield* syncSetting({
        label: `sql managed instance administrator on ${scope.managedInstanceName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) => fieldsMatch(observed.properties, desired),
        put: sql.ManagedInstanceAdministratorsCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          administratorName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteManagedInstanceAdministrator({
          ...instancePath(subscriptionId, output),
          administratorName: SETTING_NAME,
        }),
      );
      yield* waitUntilGone(
        `sql managed instance administrator on ${output.managedInstanceName}`,
        getSetting(subscriptionId, output),
      );
    }),

    nuke: { singleton: true },
  });
