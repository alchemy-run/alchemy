import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { sameText } from "./Common.ts";

/**
 * Kind of link, which is also its name: `Automation` (an Automation
 * account) or `cluster` (a dedicated Log Analytics cluster).
 */
export type LinkedServiceName = "Automation" | "cluster";

export interface LinkedServiceProps {
  /**
   * Resource group of the workspace.
   *
   * :::caution
   * Changing it replaces the link.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the workspace to link, e.g. `logs.workspaceName`.
   *
   * :::caution
   * Changing it replaces the link.
   * :::
   */
  workspace: string;
  /**
   * Kind of link, which is also its name: `Automation` links an Automation
   * account (read access), `cluster` links a dedicated Log Analytics
   * cluster (write access).
   *
   * :::caution
   * Changing it replaces the link.
   * :::
   */
  name: LinkedServiceName;
  /**
   * ARM resource ID of the resource that gets read access, e.g.
   * `account.automationAccountId`. Set it for `Automation` links.
   * @default not sent
   */
  resourceId?: string;
  /**
   * ARM resource ID of the resource that gets write access, e.g.
   * `cluster.clusterId`. Set it for `cluster` links.
   * @default not sent
   */
  writeAccessResourceId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface LinkedService extends Resource<
  "Azure.LogAnalytics.LinkedService",
  LinkedServiceProps,
  {
    /** Name of the link: `Automation` or `cluster`. */
    linkedServiceName: string;
    /** Name of the workspace that is linked. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the link. */
    linkedServiceId: string;
    /** ARM resource ID of the linked resource with read access. */
    resourceId: string | undefined;
    /** ARM resource ID of the linked resource with write access. */
    writeAccessResourceId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A link from a Log Analytics workspace to another service
 * (`Microsoft.OperationalInsights/workspaces/linkedServices`): an Automation
 * account (for Update Management, Change Tracking, and runbook job logs),
 * or a dedicated Log Analytics cluster that the workspace ingests into.
 *
 * :::caution[Changing `name`, `workspace`, or `resourceGroup` replaces the link]
 * Alchemy creates the new link and deletes the old one. Deleting a
 * `cluster` link moves the workspace's new data out of the cluster.
 * :::
 *
 * :::caution[Each linked resource has rules]
 * An Automation account can be linked to only one workspace, in a
 * supported region pair. A `cluster` link needs an existing
 * `Azure.LogAnalytics.Cluster` in the workspace's region. Linking a cluster
 * moves the workspace's new data into the cluster.
 * :::
 *
 * @see https://learn.microsoft.com/azure/automation/how-to/region-mappings
 *
 * ### Linking an Automation Account
 * **Example:** Link an Automation account
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const account = yield* Azure.Automation.AutomationAccount("ops");
 * yield* Azure.LogAnalytics.LinkedService("automation", {
 *   workspace: logs.workspaceName,
 *   name: "Automation",
 *   resourceId: account.automationAccountId,
 * });
 * ```
 *
 * ### Linking a Dedicated Cluster
 * **Example:** Move a workspace into a cluster
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const cluster = yield* Azure.LogAnalytics.Cluster("logs-cluster");
 * yield* Azure.LogAnalytics.LinkedService("cluster", {
 *   workspace: logs.workspaceName,
 *   name: "cluster",
 *   writeAccessResourceId: cluster.clusterId,
 * });
 * ```
 *
 * @resource
 */
export const LinkedService = GroupedResource<LinkedService>("Azure.LogAnalytics.LinkedService");

type ObservedLink = operationalinsights.GetLinkedServiceResponse;

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  linkedServiceName: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetLinkedService({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      linkedServiceName,
    }),
  ).pipe(
    // An unlinked service lingers in `Deleting` until the async delete ends.
    Effect.map((link) => (link?.properties.provisioningState === "Deleting" ? undefined : link)),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  link: ObservedLink,
): LinkedService["Attributes"] => ({
  linkedServiceName: name,
  workspace,
  resourceGroup,
  linkedServiceId: link.id ?? "",
  resourceId: link.properties.resourceId,
  writeAccessResourceId: link.properties.writeAccessResourceId,
  tags: userTags(link.tags),
});

export const LinkedServiceProvider = () =>
  Provider.succeed(LinkedService, {
    stables: ["linkedServiceName", "workspace", "resourceGroup", "linkedServiceId"],

    // Links live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.name, output.linkedServiceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      const name = output?.linkedServiceName ?? olds?.name;
      if (resourceGroup === undefined || workspace === undefined || name === undefined) {
        return undefined;
      }
      const observed = yield* getLink(subscriptionId, resourceGroup, workspace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const { resourceGroup, workspace, name } = news;
      const tags = yield* desiredTags(id, news.tags);
      const get = getLink(subscriptionId, resourceGroup, workspace, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is an upsert of the whole link.
      if (
        observed === undefined ||
        !sameText(observed.properties.resourceId, news.resourceId) ||
        !sameText(observed.properties.writeAccessResourceId, news.writeAccessResourceId) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* operationalinsights.LinkedServicesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          linkedServiceName: name,
          properties: {
            resourceId: news.resourceId,
            writeAccessResourceId: news.writeAccessResourceId,
          },
          tags,
        });
      }

      // Linking a cluster can take a while (`ProvisioningAccount`).
      const fresh = yield* waitForProvisioned(
        `linked service ${name}`,
        get,
        (link) => link.properties.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteLinkedService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          linkedServiceName: output.linkedServiceName,
        }),
      );
      yield* waitUntilGone(
        `linked service ${output.linkedServiceName}`,
        getLink(subscriptionId, output.resourceGroup, output.workspace, output.linkedServiceName),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
