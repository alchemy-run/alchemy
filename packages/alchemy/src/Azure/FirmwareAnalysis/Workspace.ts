import * as fist from "@distilled.cloud/azure/fist";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * SKU of a firmware analysis workspace.
 */
export interface WorkspaceSku {
  /**
   * Name of the SKU, e.g. `Free` or `Standard`.
   */
  name: string;
  /**
   * Tier of the SKU.
   */
  tier?: "Free" | "Basic" | "Standard" | "Premium";
}

export interface WorkspaceProps {
  /**
   * Resource group the workspace is created in. Changing it replaces the
   * workspace.
   */
  resourceGroup: string;
  /**
   * Name of the workspace (letters, digits, and `-`, unique within the
   * resource group). If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the workspace.
   */
  name?: string;
  /**
   * Azure location of the workspace. Firmware analysis is available in a
   * limited set of regions (e.g. `eastus`, `westeurope`). Changing it
   * replaces the workspace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * SKU of the workspace. Updated in place. When omitted, the service
   * default is used and left unmanaged.
   */
  sku?: WorkspaceSku;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "Azure.FirmwareAnalysis.Workspace",
  WorkspaceProps,
  {
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group that holds the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the workspace. */
    workspaceId: string;
    /** Location of the workspace. */
    location: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Name of the SKU assigned to the workspace, if any. */
    skuName: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A firmware analysis workspace (Microsoft.IoTFirmwareDefense, formerly
 * Defender for IoT firmware analysis). Firmware images uploaded to the
 * workspace are scanned for CVEs, weak crypto, hard-coded credentials, binary
 * hardening gaps and SBOM components.
 *
 * @see https://learn.microsoft.com/azure/firmware-analysis/overview-firmware-analysis
 *
 * ### Creating a Workspace
 * **Example:** Workspace in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const workspace = yield* Azure.FirmwareAnalysis.Workspace("firmware", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Workspace with an explicit SKU and tags
 * ```typescript
 * const workspace = yield* Azure.FirmwareAnalysis.Workspace("firmware", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westeurope",
 *   sku: { name: "Free" },
 *   tags: { team: "iot" },
 * });
 * ```
 *
 * @resource
 */
export const Workspace = Resource<Workspace>(
  "Azure.FirmwareAnalysis.Workspace",
);

type ObservedWorkspace = fist.GetWorkspaceResponse;

const MAX_NAME_LENGTH = 63;

const getWorkspace = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    fist.GetWorkspace({ subscriptionId, resourceGroupName, workspaceName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  workspace: ObservedWorkspace,
): Workspace["Attributes"] => ({
  workspaceName: name,
  resourceGroup,
  workspaceId: workspace.id ?? "",
  location: workspace.location,
  provisioningState: workspace.properties?.provisioningState,
  skuName: workspace.sku?.name,
  tags: userTags(workspace.tags),
});

const skuDiffers = (
  observed: ObservedWorkspace["sku"],
  desired: WorkspaceSku | undefined,
) =>
  desired !== undefined &&
  (observed?.name?.toLowerCase() !== desired.name.toLowerCase() ||
    (desired.tier !== undefined &&
      observed?.tier?.toLowerCase() !== desired.tier.toLowerCase()));

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: ["workspaceName", "resourceGroup", "workspaceId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* fist
        .ListWorkspaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListWorkspaceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((workspace) => {
        const group = resourceGroupOf(workspace.id);
        return hasAnyAlchemyTag(workspace.tags) &&
          group !== undefined &&
          workspace.name !== undefined
          ? [toAttrs(group, workspace.name, workspace)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.workspaceName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replaceAll(" ", "").toLowerCase() !==
            output.location.replaceAll(" ", "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.workspaceName ??
        olds?.name ??
        (yield* createPhysicalName({ id, maxLength: MAX_NAME_LENGTH }));
      const observed = yield* getWorkspace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTFirmwareDefense");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.workspaceName ??
        (yield* createPhysicalName({ id, maxLength: MAX_NAME_LENGTH }));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: name,
      };
      const get = getWorkspace(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure: the PUT is synchronous, but provisioningState may still be
      // non-terminal right after it returns.
      if (observed === undefined) {
        yield* fist.CreateWorkspace({
          ...request,
          location,
          tags,
          sku: news.sku,
        });
        observed = yield* waitForProvisioned(
          `firmware analysis workspace ${name}`,
          get,
          (w) => w.properties?.provisioningState,
        );
      }

      // Sync SKU and tags against observed state.
      const syncSku = skuDiffers(observed.sku, news.sku);
      const syncTags = tagsDiffer(observed.tags, tags);
      if (syncSku || syncTags) {
        yield* fist.UpdateWorkspace({
          ...request,
          ...(syncSku ? { sku: news.sku } : {}),
          ...(syncTags ? { tags } : {}),
        });
        observed = yield* waitForProvisioned(
          `firmware analysis workspace ${name}`,
          get,
          (w) => w.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        fist.DeleteWorkspace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspaceName,
        }),
      );
      yield* waitUntilGone(
        `firmware analysis workspace ${output.workspaceName}`,
        getWorkspace(subscriptionId, output.resourceGroup, output.workspaceName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
