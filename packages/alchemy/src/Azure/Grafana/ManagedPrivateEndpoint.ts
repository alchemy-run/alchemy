import * as dashboard from "@distilled.cloud/azure/dashboard";
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
import { getGrafana } from "./Workspace.ts";

export interface ManagedPrivateEndpointProps {
  /**
   * Resource group of the Grafana workspace. Changing it replaces the
   * endpoint.
   */
  resourceGroup: string;
  /**
   * Name of the Grafana workspace (Standard tier) that owns the endpoint.
   * Changing it replaces the endpoint.
   */
  workspace: string;
  /**
   * Endpoint name: letters, digits, and hyphens, starting with a letter. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the endpoint.
   */
  name?: string;
  /**
   * Azure location; must match the workspace's location. Changing it
   * replaces the endpoint.
   * @default the workspace's location
   */
  location?: string;
  /**
   * ARM ID of the private-link resource the endpoint connects to, e.g. a
   * storage account. Changing it replaces the endpoint.
   */
  privateLinkResourceId: string;
  /**
   * Region of the private-link resource. Changing it replaces the endpoint.
   * @default the endpoint's location
   */
  privateLinkResourceRegion?: string;
  /**
   * Sub-resources (group IDs) to connect to, e.g. `["blob"]`. Changing them
   * replaces the endpoint.
   */
  groupIds: string[];
  /** Message sent to the owner of the target with the connection request. */
  requestMessage?: string;
  /**
   * Host of the data store behind a private-link service, as used in the
   * Grafana data source (without protocol and port).
   */
  privateLinkServiceUrl?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ManagedPrivateEndpoint extends Resource<
  "Azure.Grafana.ManagedPrivateEndpoint",
  ManagedPrivateEndpointProps,
  {
    /** Name of the endpoint. */
    managedPrivateEndpointName: string;
    /** ARM resource ID of the endpoint. */
    managedPrivateEndpointId: string;
    /** Name of the Grafana workspace. */
    workspace: string;
    /** Resource group of the Grafana workspace. */
    resourceGroup: string;
    /** Location of the endpoint. */
    location: string;
    /** ARM ID of the private-link resource. */
    privateLinkResourceId: string | undefined;
    /** Region of the private-link resource. */
    privateLinkResourceRegion: string | undefined;
    /** Connected group IDs. */
    groupIds: string[];
    /**
     * Connection approval status (`Pending`, `Approved`, `Rejected`,
     * `Disconnected`). The target's owner approves the connection.
     */
    connectionStatus: string | undefined;
    /** Private IP of the endpoint once the connection is approved. */
    privateLinkServicePrivateIP: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A managed private endpoint of an Azure Managed Grafana workspace — lets
 * Grafana reach a data source (storage account, Azure Data Explorer, SQL,
 * private-link service, ...) over Azure Private Link. The target's owner
 * must approve the connection before traffic flows.
 *
 * Requires a Standard-tier workspace.
 *
 * @see https://learn.microsoft.com/azure/managed-grafana/how-to-connect-to-data-source-privately
 *
 * ### Connecting Privately to a Data Source
 * **Example:** Private endpoint to a storage account's blob service
 * ```typescript
 * const endpoint = yield* Azure.Grafana.ManagedPrivateEndpoint("blob", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: grafana.workspaceName,
 *   privateLinkResourceId: account.storageAccountId,
 *   groupIds: ["blob"],
 *   requestMessage: "Grafana access",
 * });
 * // endpoint.connectionStatus is "Pending" until the account owner approves
 * ```
 *
 * @resource
 */
export const ManagedPrivateEndpoint = Resource<ManagedPrivateEndpoint>(
  "Azure.Grafana.ManagedPrivateEndpoint",
);

const createEndpointName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 20,
    lowercase: true,
    delimiter: "-",
  });
  const cleaned = name.replace(/[^a-z0-9-]/g, "").replace(/-+$/, "");
  return /^[a-z]/.test(cleaned) ? cleaned : `e${cleaned}`.slice(0, 20);
});

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  managedPrivateEndpointName: string,
) =>
  orUndefinedIfNotFound(
    dashboard.GetManagedPrivateEndpoint({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      managedPrivateEndpointName,
    }),
  );

const lower = (value: string | undefined) =>
  value?.toLowerCase().replaceAll(" ", "");

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  endpoint:
    | dashboard.GetManagedPrivateEndpointResponse
    | dashboard.ManagedPrivateEndpointModel,
): ManagedPrivateEndpoint["Attributes"] => ({
  managedPrivateEndpointName: name,
  managedPrivateEndpointId: endpoint.id ?? "",
  workspace,
  resourceGroup,
  location: endpoint.location,
  privateLinkResourceId: endpoint.properties?.privateLinkResourceId,
  privateLinkResourceRegion: endpoint.properties?.privateLinkResourceRegion,
  groupIds: [...(endpoint.properties?.groupIds ?? [])],
  connectionStatus: endpoint.properties?.connectionState?.status,
  privateLinkServicePrivateIP:
    endpoint.properties?.privateLinkServicePrivateIP,
  tags: userTags(endpoint.tags),
});

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  const left = new Set(a.map((value) => value.toLowerCase()));
  const right = new Set(b.map((value) => value.toLowerCase()));
  return left.size === right.size && [...left].every((v) => right.has(v));
};

/** Whether the PUT-only settings differ from the observed endpoint. */
const settingsDiffer = (
  news: ManagedPrivateEndpointProps,
  observed: dashboard.GetManagedPrivateEndpointResponse,
) =>
  (news.requestMessage !== undefined &&
    news.requestMessage !== observed.properties?.requestMessage) ||
  (news.privateLinkServiceUrl !== undefined &&
    news.privateLinkServiceUrl !== observed.properties?.privateLinkServiceUrl);

const BUDGET = { interval: "5 seconds", times: 72 } as const;

export const ManagedPrivateEndpointProvider = () =>
  Provider.succeed(ManagedPrivateEndpoint, {
    stables: [
      "managedPrivateEndpointName",
      "managedPrivateEndpointId",
      "workspace",
      "resourceGroup",
      "location",
      "privateLinkResourceId",
      "groupIds",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const workspaces = yield* orUndefinedIfNotFound(
        dashboard.ListGrafana({ subscriptionId }),
      );
      if (workspaces === undefined) return [];
      yield* requireSinglePage("ListGrafana", workspaces);
      const found: ManagedPrivateEndpoint["Attributes"][] = [];
      for (const grafana of workspaces.value ?? []) {
        const group = resourceGroupOf(grafana.id);
        if (group === undefined || grafana.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          dashboard.ListManagedPrivateEndpoints({
            subscriptionId,
            resourceGroupName: group,
            workspaceName: grafana.name,
          }),
        );
        if (page === undefined) continue;
        yield* requireSinglePage("ListManagedPrivateEndpoints", page);
        for (const endpoint of page.value ?? []) {
          if (hasAnyAlchemyTag(endpoint.tags) && endpoint.name !== undefined) {
            found.push(toAttrs(group, grafana.name, endpoint.name, endpoint));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspace) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.managedPrivateEndpointName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        lower(news.privateLinkResourceId) !==
          lower(output.privateLinkResourceId) ||
        (news.privateLinkResourceRegion !== undefined &&
          lower(news.privateLinkResourceRegion) !==
            lower(output.privateLinkResourceRegion)) ||
        !sameSet(news.groupIds, output.groupIds)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.managedPrivateEndpointName ??
        olds?.name ??
        (yield* createEndpointName(id));
      const observed = yield* getEndpoint(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Dashboard");
      const { resourceGroup, workspace } = news;
      const name =
        news.name ??
        output?.managedPrivateEndpointName ??
        (yield* createEndpointName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        managedPrivateEndpointName: name,
      };
      const get = getEndpoint(subscriptionId, resourceGroup, workspace, name);
      const label = `Grafana managed private endpoint ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a create-or-replace, so it also applies the
      // settings PATCH cannot change (request message, service URL).
      if (observed === undefined || settingsDiffer(news, observed)) {
        const location =
          news.location ??
          output?.location ??
          observed?.location ??
          (yield* getGrafana(subscriptionId, resourceGroup, workspace))
            ?.location ??
          env.location;
        yield* dashboard.CreateManagedPrivateEndpoint({
          ...where,
          location,
          tags,
          properties: {
            privateLinkResourceId: news.privateLinkResourceId,
            privateLinkResourceRegion:
              news.privateLinkResourceRegion ??
              observed?.properties?.privateLinkResourceRegion ??
              location,
            groupIds: news.groupIds,
            requestMessage: news.requestMessage,
            privateLinkServiceUrl: news.privateLinkServiceUrl,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (endpoint) =>
          settingsDiffer(news, endpoint)
            ? "Updating"
            : endpoint.properties?.provisioningState,
        BUDGET,
      );

      // Sync tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* dashboard.UpdateManagedPrivateEndpoint({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (endpoint) =>
            tagsDiffer(endpoint.tags, tags)
              ? "Updating"
              : endpoint.properties?.provisioningState,
          BUDGET,
        );
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dashboard.DeleteManagedPrivateEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          managedPrivateEndpointName: output.managedPrivateEndpointName,
        }),
      );
      yield* waitUntilGone(
        `Grafana managed private endpoint ${output.managedPrivateEndpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.managedPrivateEndpointName,
        ),
        BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Grafana.Workspace", "Azure.Resources.ResourceGroup"],
    },
  });
