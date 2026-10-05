import * as synapse from "@distilled.cloud/azure/synapse";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { ensureRegistered, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isWorkspaceOwnedByStack, lower, syncSetting } from "./common.ts";

/** The protector is a singleton named `current`. */
const PROTECTOR_NAME = "current";

/**
 * The workspace exposes no encryption protector: Azure answers every
 * GET/PUT on `encryptionProtector` with an empty-bodied 404. Observed on
 * service-managed workspaces and also on activated customer-managed-key
 * workspaces with a dedicated SQL pool (api-versions 2019-06-01-preview
 * through 2021-06-01-preview, Oct 2026).
 */
export class EncryptionProtectorUnavailable extends Data.TaggedError(
  "Azure.Synapse.EncryptionProtectorUnavailable",
)<{ readonly message: string }> {}

export interface EncryptionProtectorProps {
  /** Resource group of the workspace. Changing it replaces the protector. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the protector. */
  workspace: string;
  /**
   * `AzureKeyVault` to protect SQL pool TDE keys with a workspace key, or
   * `ServiceManaged` for a Microsoft-managed key.
   */
  serverKeyType: "AzureKeyVault" | "ServiceManaged";
  /**
   * Name of the workspace key for `AzureKeyVault`, in the form
   * `{vault}_{key}_{version}`.
   */
  serverKeyName?: string;
}

export interface EncryptionProtector extends Resource<
  "Azure.Synapse.EncryptionProtector",
  EncryptionProtectorProps,
  {
    /** ARM resource ID of the protector. */
    protectorId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Key type. */
    serverKeyType: string | undefined;
    /** Key name. */
    serverKeyName: string | undefined;
    /** Key Vault key URI. */
    uri: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The TDE protector of a Synapse workspace's dedicated SQL pools — the key
 * that wraps every pool's database encryption key. Requires a workspace
 * created with a customer-managed key. Azure currently answers the
 * protector endpoint with an empty 404 even on activated CMK workspaces
 * (the workspace key, see `WorkspaceKey`, is what actually protects
 * them); reconcile then fails with `EncryptionProtectorUnavailable`.
 *
 * This is a singleton setting that always exists on a CMK workspace. Azure
 * cannot remove a protector, so destroying the resource leaves the current
 * key in place (switching a CMK workspace back to a service-managed key is
 * not supported).
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/security/workspaces-encryption
 *
 * ### Configuring the Protector
 * **Example:** Protect TDE keys with a Key Vault key
 * ```typescript
 * yield* Azure.Synapse.EncryptionProtector("tde-protector", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   serverKeyType: "AzureKeyVault",
 *   serverKeyName: "myvault_cmk_0123456789abcdef0123456789abcdef",
 * });
 * ```
 *
 * @resource
 */
export const EncryptionProtector = Resource<EncryptionProtector>(
  "Azure.Synapse.EncryptionProtector",
);

type Observed = synapse.GetWorkspaceManagedSqlServerEncryptionProtectorResponse;

const getProtector = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetWorkspaceManagedSqlServerEncryptionProtector({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      encryptionProtectorName: PROTECTOR_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  protector: Observed,
): EncryptionProtector["Attributes"] => ({
  protectorId: protector.id ?? "",
  workspaceName,
  resourceGroup,
  serverKeyType: protector.properties?.serverKeyType,
  serverKeyName: protector.properties?.serverKeyName,
  uri: protector.properties?.uri,
});

export const EncryptionProtectorProvider = () =>
  Provider.succeed(EncryptionProtector, {
    stables: ["protectorId", "workspaceName", "resourceGroup"],

    // A per-workspace singleton; it disappears with its workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspaceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspaceName ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const observed = yield* getProtector(
        subscriptionId,
        resourceGroup,
        workspace,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, observed);
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          resourceGroup,
          workspace,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const { resourceGroup, workspace, serverKeyType, serverKeyName } = news;
      const fresh = yield* syncSetting({
        label: `synapse encryption protector on ${workspace}`,
        get: getProtector(subscriptionId, resourceGroup, workspace),
        matches: (protector: Observed) =>
          lower(protector.properties?.serverKeyType) === lower(serverKeyType) &&
          (serverKeyName === undefined ||
            lower(protector.properties?.serverKeyName) ===
              lower(serverKeyName)),
        put: synapse.WorkspaceManagedSqlServerEncryptionProtectorCreateOrUpdate(
          {
            subscriptionId,
            resourceGroupName: resourceGroup,
            workspaceName: workspace,
            encryptionProtectorName: PROTECTOR_NAME,
            properties: { serverKeyType, serverKeyName },
          },
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.fail(
              new EncryptionProtectorUnavailable({
                message: `workspace ${workspace} exposes no encryption protector (Azure answered 404); it needs a customer-managed key, and Azure may not expose the protector even then`,
              }),
            ),
          ),
        ),
      });
      return toAttrs(resourceGroup, workspace, fresh);
    }),

    // The protector cannot be removed; Azure keeps the current key.
    delete: Effect.fn(function* () {}),

    nuke: { singleton: true },
  });
