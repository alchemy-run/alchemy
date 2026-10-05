import * as loadtestservice from "@distilled.cloud/azure/loadtestservice";
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

export interface PlaywrightWorkspaceProps {
  /**
   * Resource group of the workspace. Changing it replaces the workspace.
   */
  resourceGroup: string;
  /**
   * Workspace name: 3-24 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the workspace.
   */
  name?: string;
  /**
   * Azure region. Playwright Workspaces are available in a subset of
   * regions (e.g. `eastus`, `westus3`, `westeurope`, `eastasia`). Changing
   * it replaces the workspace.
   * @default the stack's Azure location
   */
  location?: string;
  /**
   * When `Enabled`, client workers connect to browsers in the closest
   * Azure region; when `Disabled`, to browsers in the workspace's region.
   * @default Azure's default (`Enabled`)
   */
  regionalAffinity?: "Enabled" | "Disabled";
  /**
   * Allow local authentication with service access tokens.
   * @default Azure's default (`Disabled`)
   */
  localAuth?: "Enabled" | "Disabled";
  /** User tags. Alchemy ownership tags are merged in. */
  tags?: Record<string, string>;
}

export interface PlaywrightWorkspace extends Resource<
  "Azure.LoadTesting.PlaywrightWorkspace",
  PlaywrightWorkspaceProps,
  {
    /** Name of the workspace. */
    workspaceName: string;
    /** ARM resource ID of the workspace. */
    playwrightWorkspaceId: string;
    /** Workspace ID (GUID) used by the Playwright service. */
    workspaceId: string | undefined;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Region of the workspace. */
    location: string;
    /**
     * Data-plane service URI; pass it to Playwright as
     * `PLAYWRIGHT_SERVICE_URL`.
     */
    dataplaneUri: string | undefined;
    /** Observed regional affinity setting. */
    regionalAffinity: string | undefined;
    /** Observed local authentication setting. */
    localAuth: string | undefined;
    /** Provisioning state reported by ARM. */
    provisioningState: string | undefined;
    /** User tags (ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Playwright Workspace (Azure App Testing): cloud-hosted browsers for
 * running Playwright tests at scale. Billing is per test minute, so an idle
 * workspace costs nothing.
 *
 * @see https://learn.microsoft.com/azure/app-testing/playwright-workspaces/overview-what-is-microsoft-playwright-workspaces
 *
 * ### Creating a Workspace
 * **Example:** Playwright workspace in East US
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("e2e", {
 *   location: "eastus",
 * });
 * const workspace = yield* Azure.LoadTesting.PlaywrightWorkspace("browsers", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // PLAYWRIGHT_SERVICE_URL
 * const url = workspace.dataplaneUri;
 * ```
 *
 * ### Authentication and Affinity
 * **Example:** Allow access tokens and pin browsers to the workspace region
 * ```typescript
 * const workspace = yield* Azure.LoadTesting.PlaywrightWorkspace("browsers", {
 *   resourceGroup: group.resourceGroupName,
 *   localAuth: "Enabled",
 *   regionalAffinity: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const PlaywrightWorkspace = Resource<PlaywrightWorkspace>(
  "Azure.LoadTesting.PlaywrightWorkspace",
);

type ObservedWorkspace = loadtestservice.GetPlaywrightWorkspaceResponse;

const createWorkspaceName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
    delimiter: "-",
  });
  return name.replace(/[^a-z0-9-]/g, "-");
});

const getWorkspace = (
  subscriptionId: string,
  resourceGroupName: string,
  playwrightWorkspaceName: string,
) =>
  orUndefinedIfNotFound(
    loadtestservice.GetPlaywrightWorkspace({
      subscriptionId,
      resourceGroupName,
      playwrightWorkspaceName,
    }),
  );

const lower = (value: string | undefined) =>
  value?.toLowerCase().replaceAll(" ", "");

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedWorkspace,
): PlaywrightWorkspace["Attributes"] => ({
  workspaceName: name,
  playwrightWorkspaceId: observed.id ?? "",
  workspaceId: observed.properties?.workspaceId,
  resourceGroup,
  location: observed.location,
  dataplaneUri: observed.properties?.dataplaneUri,
  regionalAffinity: observed.properties?.regionalAffinity,
  localAuth: observed.properties?.localAuth,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

export const PlaywrightWorkspaceProvider = () =>
  Provider.succeed(PlaywrightWorkspace, {
    stables: [
      "workspaceName",
      "playwrightWorkspaceId",
      "workspaceId",
      "resourceGroup",
      "location",
      "dataplaneUri",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* loadtestservice
        .ListPlaywrightWorkspaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPlaywrightWorkspaceBySubscription", page),
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
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.workspaceName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location))
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
        output?.workspaceName ?? olds?.name ?? (yield* createWorkspaceName(id));
      const observed = yield* getWorkspace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.LoadTestService");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.workspaceName ?? (yield* createWorkspaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        playwrightWorkspaceName: name,
      };
      const label = `Playwright workspace ${name}`;
      const get = getWorkspace(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* loadtestservice.PlaywrightWorkspacesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            regionalAffinity: news.regionalAffinity,
            localAuth: news.localAuth,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (workspace) => workspace.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Sync settings and tags against observed state; PATCH only deltas.
      const props = observed.properties;
      const affinityChanged =
        news.regionalAffinity !== undefined &&
        news.regionalAffinity !== props?.regionalAffinity;
      const localAuthChanged =
        news.localAuth !== undefined && news.localAuth !== props?.localAuth;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (affinityChanged || localAuthChanged || tagsChanged) {
        yield* loadtestservice.UpdatePlaywrightWorkspace({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties:
            affinityChanged || localAuthChanged
              ? {
                  regionalAffinity: affinityChanged
                    ? news.regionalAffinity
                    : undefined,
                  localAuth: localAuthChanged ? news.localAuth : undefined,
                }
              : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (workspace) => workspace.properties?.provisioningState,
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        loadtestservice.DeletePlaywrightWorkspace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          playwrightWorkspaceName: output.workspaceName,
        }),
      );
      yield* waitUntilGone(
        `Playwright workspace ${output.workspaceName}`,
        getWorkspace(subscriptionId, output.resourceGroup, output.workspaceName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
