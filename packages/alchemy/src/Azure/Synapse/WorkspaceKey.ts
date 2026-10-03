import * as synapse from "@distilled.cloud/azure/synapse";
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
import { isWorkspaceOwnedByStack, lower, syncSetting } from "./common.ts";

export interface WorkspaceKeyProps {
  /** Resource group of the workspace. Changing it replaces the key. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the key. */
  workspace: string;
  /**
   * Name of the workspace key. To activate double encryption, use the
   * `keyName` the workspace was created with. Changing it replaces the key.
   */
  name: string;
  /**
   * Key Vault key URL (without version), e.g.
   * `https://{vault}.vault.azure.net/keys/{key}`. Changing it replaces the
   * key.
   */
  keyVaultUrl: string;
  /**
   * Whether this key is the workspace's active customer-managed key.
   * Activating it completes the setup of a CMK-encrypted workspace; the
   * workspace identity needs `get`, `wrapKey`, and `unwrapKey` on the key.
   * @default true
   */
  isActiveCMK?: boolean;
}

export interface WorkspaceKey extends Resource<
  "Azure.Synapse.WorkspaceKey",
  WorkspaceKeyProps,
  {
    /** Name of the key. */
    keyName: string;
    /** ARM resource ID of the key. */
    keyId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Key Vault key URL. */
    keyVaultUrl: string | undefined;
    /** Whether the key is the active customer-managed key. */
    isActiveCMK: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * A customer-managed key registered with a Synapse workspace. A workspace
 * created with `customerManagedKey` stays pending until its key is
 * activated here; the active key wraps the workspace's data encryption
 * keys (double encryption).
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/security/workspaces-encryption
 *
 * ### Activating Double Encryption
 * **Example:** Activate the workspace's customer-managed key
 * ```typescript
 * const workspace = yield* Azure.Synapse.Workspace("ws", {
 *   resourceGroup: group.resourceGroupName,
 *   defaultDataLakeStorage: { accountUrl, filesystem },
 *   customerManagedKey: { keyName: "cmk", keyVaultUrl: key.keyUrl },
 * });
 * // grant workspace.principalId get/wrapKey/unwrapKey on the key, then:
 * yield* Azure.Synapse.WorkspaceKey("cmk", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   name: "cmk",
 *   keyVaultUrl: key.keyUrl,
 *   isActiveCMK: true,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceKey = Resource<WorkspaceKey>(
  "Azure.Synapse.WorkspaceKey",
);

type Observed = synapse.GetKeyResponse;

const getKey = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  keyName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetKey({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      keyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  name: string,
  key: Observed,
): WorkspaceKey["Attributes"] => ({
  keyName: name,
  keyId: key.id ?? "",
  workspaceName,
  resourceGroup,
  keyVaultUrl: key.properties?.keyVaultUrl,
  isActiveCMK: key.properties?.isActiveCMK,
});

const sameUrl = (a: string | undefined, b: string | undefined) =>
  lower(a?.replace(/\/$/, "")) === lower(b?.replace(/\/$/, ""));

export const WorkspaceKeyProvider = () =>
  Provider.succeed(WorkspaceKey, {
    stables: ["keyName", "keyId", "workspaceName", "resourceGroup"],

    // Keys live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspaceName) ||
        news.name !== output.keyName ||
        !sameUrl(news.keyVaultUrl, output.keyVaultUrl)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspaceName ?? olds?.workspace;
      const name = output?.keyName ?? olds?.name;
      if (
        resourceGroup === undefined ||
        workspace === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getKey(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
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
      const { resourceGroup, workspace, name, keyVaultUrl } = news;
      const isActiveCMK = news.isActiveCMK ?? true;
      const fresh = yield* syncSetting({
        label: `synapse workspace key ${name}`,
        get: getKey(subscriptionId, resourceGroup, workspace, name),
        matches: (key: Observed) =>
          sameUrl(key.properties?.keyVaultUrl, keyVaultUrl) &&
          (key.properties?.isActiveCMK ?? false) === isActiveCMK,
        put: synapse.KeysCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          keyName: name,
          properties: { keyVaultUrl, isActiveCMK },
        }),
      });
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        synapse.DeleteKey({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspaceName,
          keyName: output.keyName,
        }),
      );
      yield* waitUntilGone(
        `synapse workspace key ${output.keyName}`,
        getKey(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
          output.keyName,
        ),
      );
    }),
  });
