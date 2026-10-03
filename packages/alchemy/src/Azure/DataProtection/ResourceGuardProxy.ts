import * as dataprotection from "@distilled.cloud/azure/dataprotection";
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
import { isVaultOwnedByStack, NAMESPACE, sameText } from "./Common.ts";

/** Azure allows exactly one proxy per vault, with this fixed name. */
const PROXY_NAME = "DppResourceGuardProxy";

export interface ResourceGuardProxyProps {
  /** Resource group of the Backup vault. Changing it replaces the proxy. */
  resourceGroup: string;
  /** Name of the Backup vault to protect. Changing it replaces the proxy. */
  backupVault: string;
  /**
   * ARM ID of the {@link ResourceGuard} that protects the vault. Changing it
   * replaces the proxy.
   */
  resourceGuardId: string;
  /**
   * Free-form description sent when the link is created. Azure does not
   * return it, so later changes are not synced.
   */
  description?: string;
}

export interface ResourceGuardProxy extends Resource<
  "Azure.DataProtection.ResourceGuardProxy",
  ResourceGuardProxyProps,
  {
    /** Name of the proxy (always `DppResourceGuardProxy`). */
    resourceGuardProxyName: string;
    /** ARM resource ID of the proxy. */
    resourceGuardProxyId: string;
    /** Backup vault the proxy protects. */
    backupVault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM ID of the linked resource guard. */
    resourceGuardId: string;
    /** Critical operations the guard protects on this vault. */
    resourceGuardOperations: string[];
    /** When the link was last updated. */
    lastUpdatedTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Links a Backup vault to a {@link ResourceGuard}
 * (`Microsoft.DataProtection/backupVaults/backupResourceGuardProxies`),
 * enabling multi-user authorization on the vault. A vault has at most one
 * proxy, always named `DppResourceGuardProxy`.
 *
 * Deleting the proxy is itself a critical operation: Alchemy first calls
 * `unlockDelete`, which needs `Backup MUA Operator` on the guard unless the
 * guard excludes
 * `Microsoft.DataProtection/backupVaults/backupResourceGuardProxies/delete`.
 *
 * @see https://learn.microsoft.com/azure/backup/multi-user-authorization
 *
 * ### Protecting a Vault
 * **Example:** Link a vault to a resource guard
 * ```typescript
 * const guard = yield* Azure.DataProtection.ResourceGuard("guard", {
 *   resourceGroup: securityGroup.resourceGroupName,
 * });
 * const vault = yield* Azure.DataProtection.BackupVault("vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.DataProtection.ResourceGuardProxy("mua", {
 *   resourceGroup: group.resourceGroupName,
 *   backupVault: vault.backupVaultName,
 *   resourceGuardId: guard.resourceGuardId,
 * });
 * ```
 *
 * @resource
 */
export const ResourceGuardProxy = Resource<ResourceGuardProxy>(
  "Azure.DataProtection.ResourceGuardProxy",
);

const getProxy = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) =>
  orUndefinedIfNotFound(
    dataprotection.GetDppResourceGuardProxy({
      subscriptionId,
      resourceGroupName,
      vaultName,
      resourceGuardProxyName: PROXY_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  backupVault: string,
  proxy: dataprotection.GetDppResourceGuardProxyResponse,
): ResourceGuardProxy["Attributes"] => ({
  resourceGuardProxyName: PROXY_NAME,
  resourceGuardProxyId: proxy.id ?? "",
  backupVault,
  resourceGroup,
  resourceGuardId: proxy.properties?.resourceGuardResourceId ?? "",
  resourceGuardOperations: (
    proxy.properties?.resourceGuardOperationDetails ?? []
  )
    .map((op) => op.vaultCriticalOperation)
    .filter((op): op is string => op !== undefined),
  lastUpdatedTime: proxy.properties?.lastUpdatedTime,
});

export const ResourceGuardProxyProvider = () =>
  Provider.succeed(ResourceGuardProxy, {
    stables: [
      "resourceGuardProxyName",
      "resourceGuardProxyId",
      "backupVault",
      "resourceGroup",
      "resourceGuardId",
    ],

    // Proxies live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.backupVault, output.backupVault) ||
        !sameText(news.resourceGuardId, output.resourceGuardId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const backupVault = output?.backupVault ?? olds?.backupVault;
      if (resourceGroup === undefined || backupVault === undefined) {
        return undefined;
      }
      const observed = yield* getProxy(
        subscriptionId,
        resourceGroup,
        backupVault,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, backupVault, observed);
      return (yield* isVaultOwnedByStack(
        subscriptionId,
        resourceGroup,
        backupVault,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, backupVault } = news;
      const get = getProxy(subscriptionId, resourceGroup, backupVault);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: PUT is a synchronous upsert, sent only when the
      // proxy is missing or points at another guard.
      if (
        observed === undefined ||
        !sameText(
          observed.properties?.resourceGuardResourceId,
          news.resourceGuardId,
        )
      ) {
        yield* dataprotection.DppResourceGuardProxyCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vaultName: backupVault,
          resourceGuardProxyName: PROXY_NAME,
          properties: {
            resourceGuardResourceId: news.resourceGuardId,
            description: news.description,
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `resource guard proxy of ${backupVault}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, backupVault, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        vaultName: output.backupVault,
        resourceGuardProxyName: PROXY_NAME,
      };
      const observed = yield* getProxy(
        subscriptionId,
        output.resourceGroup,
        output.backupVault,
      );
      if (observed !== undefined) {
        // Removing the proxy is a critical operation guarded by the
        // resource guard itself; unlock it first.
        yield* ignoreNotFound(
          dataprotection.DppResourceGuardProxyUnlockDelete({
            ...where,
            resourceGuardOperationRequests: [
              `${output.resourceGuardId}/deleteResourceGuardProxyRequests/default`,
            ],
            resourceToBeDeleted: observed.id,
          }),
        );
        yield* ignoreNotFound(
          dataprotection.DeleteDppResourceGuardProxy(where),
        );
      }
      yield* waitUntilGone(
        `resource guard proxy of ${output.backupVault}`,
        getProxy(subscriptionId, output.resourceGroup, output.backupVault),
      );
    }),
  });
