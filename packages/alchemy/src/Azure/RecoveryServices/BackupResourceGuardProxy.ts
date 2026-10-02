import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
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
import {
  isVaultOwnedByStack,
  RECOVERY_SERVICES_NAMESPACE,
  sameId,
} from "./BackupShared.ts";

export interface BackupResourceGuardProxyProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the proxy. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the proxy. */
  vault: string;
  /**
   * ARM ID of the `Microsoft.DataProtection/resourceGuards` resource that
   * protects the vault. Changing it replaces the proxy.
   */
  resourceGuardResourceId: string;
  /**
   * Proxy name. A vault has a single resource guard proxy.
   * @default "VaultProxy"
   */
  name?: string;
  /** Description of the association. */
  description?: string;
}

export interface BackupResourceGuardProxy extends Resource<
  "Azure.RecoveryServices.BackupResourceGuardProxy",
  BackupResourceGuardProxyProps,
  {
    /** Name of the proxy. */
    resourceGuardProxyName: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the proxy. */
    resourceGuardProxyId: string;
    /** ARM ID of the resource guard. */
    resourceGuardResourceId: string;
    /** Description of the association. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Associates a Recovery Services vault with a Resource Guard
 * (`Microsoft.DataProtection/resourceGuards`) to enable multi-user
 * authorization: critical operations on the vault (disabling soft delete,
 * reducing retention, stopping protection) then also need permission on
 * the guard.
 *
 * The proxy cannot be tagged; Alchemy treats it as owned when its vault is
 * tagged for the current stack and stage. Destroying the resource first
 * unlocks the delete through the guard (the deploying identity needs the
 * `Backup MUA Operator` role or equivalent on the guard), then removes the
 * association.
 *
 * @see https://learn.microsoft.com/azure/backup/multi-user-authorization
 *
 * ### Multi-User Authorization
 * **Example:** Protect a vault with a resource guard
 * ```typescript
 * yield* Azure.RecoveryServices.BackupResourceGuardProxy("vault-guard", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: "my-vault",
 *   resourceGuardResourceId: guardId,
 *   description: "Security team approval required",
 * });
 * ```
 *
 * @resource
 */
export const BackupResourceGuardProxy = Resource<BackupResourceGuardProxy>(
  "Azure.RecoveryServices.BackupResourceGuardProxy",
);

const DEFAULT_NAME = "VaultProxy";

type Observed = backup.GetResourceGuardProxyResponse2;

const getProxy = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  resourceGuardProxyName: string,
) =>
  orUndefinedIfNotFound(
    backup.GetResourceGuardProxy2({
      subscriptionId,
      resourceGroupName,
      vaultName,
      resourceGuardProxyName,
    }),
  ).pipe(
    // A missing proxy can come back as an empty body.
    Effect.map((proxy) =>
      proxy?.properties?.resourceGuardResourceId ? proxy : undefined,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  observed: Observed,
): BackupResourceGuardProxy["Attributes"] => ({
  resourceGuardProxyName: name,
  vault,
  resourceGroup,
  resourceGuardProxyId: observed.id ?? "",
  resourceGuardResourceId: observed.properties?.resourceGuardResourceId ?? "",
  description: observed.properties?.description || undefined,
});

export const BackupResourceGuardProxyProvider = () =>
  Provider.succeed(BackupResourceGuardProxy, {
    stables: [
      "resourceGuardProxyName",
      "vault",
      "resourceGroup",
      "resourceGuardProxyId",
    ],

    // The proxy lives inside a vault; nuke removes it with the vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.vault.toLowerCase() !== output.vault.toLowerCase() ||
        !sameId(news.name ?? DEFAULT_NAME, output.resourceGuardProxyName) ||
        !sameId(news.resourceGuardResourceId, output.resourceGuardResourceId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      if (resourceGroup === undefined || vault === undefined) return undefined;
      const name =
        output?.resourceGuardProxyName ?? olds?.name ?? DEFAULT_NAME;
      const observed = yield* getProxy(
        subscriptionId,
        resourceGroup,
        vault,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vault, name, observed);
      return output !== undefined ||
        (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, RECOVERY_SERVICES_NAMESPACE);
      const { resourceGroup, vault, resourceGuardResourceId } = news;
      const name = news.name ?? DEFAULT_NAME;
      const get = getProxy(subscriptionId, resourceGroup, vault, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync the description (the guard ID is immutable).
      if (
        observed === undefined ||
        (news.description !== undefined &&
          (observed.properties?.description ?? "") !== news.description)
      ) {
        yield* backup.PutResourceGuardProxy({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vaultName: vault,
          resourceGuardProxyName: name,
          properties: {
            resourceGuardResourceId,
            description: news.description,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `resource guard proxy ${name}`,
        get,
        () => undefined,
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(resourceGroup, vault, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        vaultName: output.vault,
        resourceGuardProxyName: output.resourceGuardProxyName,
      };
      const observed = yield* getProxy(
        subscriptionId,
        output.resourceGroup,
        output.vault,
        output.resourceGuardProxyName,
      );
      if (observed === undefined) return;
      // Removing the association is itself a guarded operation.
      yield* backup.ResourceGuardProxyUnlockDelete({
        ...where,
        resourceGuardOperationRequests: [
          `${output.resourceGuardResourceId}/deleteResourceGuardProxyRequests/default`,
        ],
        resourceToBeDeleted: output.resourceGuardProxyId,
      });
      yield* ignoreNotFound(backup.DeleteResourceGuardProxy(where));
      yield* waitUntilGone(
        `resource guard proxy ${output.resourceGuardProxyName}`,
        getProxy(
          subscriptionId,
          output.resourceGroup,
          output.vault,
          output.resourceGuardProxyName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
