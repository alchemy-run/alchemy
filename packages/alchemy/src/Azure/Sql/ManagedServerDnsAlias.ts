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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createDnsName, lower } from "./common.ts";
import { instancePath, type InstanceScope } from "./setting.ts";

export interface ManagedServerDnsAliasProps {
  /** Resource group of the managed instance. Changing it replaces the alias. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the alias. */
  managedInstance: string;
  /**
   * Globally unique alias name — the `<name>.database.windows.net` DNS
   * label (lowercase letters, digits, and hyphens). If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the alias.
   */
  name?: string;
}

export interface ManagedServerDnsAlias extends Resource<
  "Azure.Sql.ManagedServerDnsAlias",
  ManagedServerDnsAliasProps,
  {
    /** Name of the alias. */
    dnsAliasName: string;
    /** ARM resource ID of the alias. */
    dnsAliasId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Private DNS record of the alias, e.g. `<name>.database.windows.net`. */
    azureDnsRecord: string | undefined;
    /** Public-endpoint DNS record of the alias, if any. */
    publicAzureDnsRecord: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A DNS alias for an Azure SQL Managed Instance — an extra
 * `<alias>.database.windows.net` name that resolves to the instance, so
 * clients survive moving to another instance without connection-string
 * changes.
 *
 * Aliases cannot be tagged; Alchemy treats an alias as its own when its
 * name is the one Alchemy generated for this resource (or it was created
 * by a previous deploy).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/dns-alias-overview
 *
 * ### Creating an Alias
 * **Example:** Stable connection name for a managed instance
 * ```typescript
 * const alias = yield* Azure.Sql.ManagedServerDnsAlias("alias", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 * });
 * // connect to alias.azureDnsRecord
 * ```
 *
 * @resource
 */
export const ManagedServerDnsAlias = Resource<ManagedServerDnsAlias>(
  "Azure.Sql.ManagedServerDnsAlias",
);

const getAlias = (subscriptionId: string, scope: InstanceScope, name: string) =>
  orUndefinedIfNotFound(
    sql.GetManagedServerDnsAlias({
      ...instancePath(subscriptionId, scope),
      dnsAliasName: name,
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  name: string,
  alias: sql.GetManagedServerDnsAliasResponse,
): ManagedServerDnsAlias["Attributes"] => ({
  dnsAliasName: name,
  dnsAliasId: alias.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  azureDnsRecord: alias.properties?.azureDnsRecord,
  publicAzureDnsRecord: alias.properties?.publicAzureDnsRecord,
});

export const ManagedServerDnsAliasProvider = () =>
  Provider.succeed(ManagedServerDnsAlias, {
    stables: [
      "dnsAliasName",
      "dnsAliasId",
      "resourceGroup",
      "managedInstanceName",
    ],

    // Aliases live inside a managed instance; they are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstanceName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.dnsAliasName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedInstanceName =
        output?.managedInstanceName ?? olds?.managedInstance;
      if (resourceGroup === undefined || managedInstanceName === undefined) {
        return undefined;
      }
      const scope = { resourceGroup, managedInstanceName };
      const generated = yield* createDnsName(id, 40);
      const name = output?.dnsAliasName ?? olds?.name ?? generated;
      const observed = yield* getAlias(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: InstanceScope = {
        resourceGroup: news.resourceGroup,
        managedInstanceName: news.managedInstance,
      };
      const name =
        news.name ?? output?.dnsAliasName ?? (yield* createDnsName(id, 40));
      const get = getAlias(subscriptionId, scope, name);

      // Observe, then ensure. The alias has no mutable properties.
      const observed = yield* get;
      if (observed === undefined) {
        yield* sql.ManagedServerDnsAliasesCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          dnsAliasName: name,
          createDnsRecord: true,
        });
      }
      const fresh = yield* waitForProvisioned(
        `sql managed instance dns alias ${name}`,
        get,
        () => undefined,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteManagedServerDnsAlias({
          ...instancePath(subscriptionId, output),
          dnsAliasName: output.dnsAliasName,
        }),
      );
      yield* waitUntilGone(
        `sql managed instance dns alias ${output.dnsAliasName}`,
        getAlias(subscriptionId, output, output.dnsAliasName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
