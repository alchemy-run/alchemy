import * as dashboard from "@distilled.cloud/azure/dashboard";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import { createGrafanaName, getGrafana } from "./Workspace.ts";

export interface IntegrationFabricProps {
  /**
   * Resource group of the Grafana workspace. Changing it replaces the
   * integration fabric.
   */
  resourceGroup: string;
  /**
   * Name of the Grafana workspace that owns the integration fabric.
   * Changing it replaces the integration fabric.
   */
  workspace: string;
  /**
   * Integration fabric name. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the integration
   * fabric.
   */
  name?: string;
  /**
   * Azure location; must match the workspace's location. Changing it
   * replaces the integration fabric.
   * @default the workspace's location
   */
  location?: string;
  /**
   * ARM ID of the resource being integrated. Omit it for a data-source-only
   * fabric (target type `NoneType`); Azure currently accepts only the
   * workspace's bundled Azure Monitor workspace (fabric name `bundled-amw`)
   * or an SRE agent as a target. Changing it replaces the integration fabric.
   */
  targetResourceId?: string;
  /**
   * ARM ID of the resource Grafana uses as data source. Azure currently
   * supports only an Azure Monitor workspace. Changing it replaces the
   * integration fabric.
   */
  dataSourceResourceId: string;
  /**
   * Integration scenarios to enable. For an Azure Monitor workspace data
   * source without a target, Azure accepts `aks` and `istio`.
   */
  scenarios?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface IntegrationFabric extends Resource<
  "Azure.Grafana.IntegrationFabric",
  IntegrationFabricProps,
  {
    /** Name of the integration fabric. */
    integrationFabricName: string;
    /** ARM resource ID of the integration fabric. */
    integrationFabricId: string;
    /** Name of the Grafana workspace. */
    workspace: string;
    /** Resource group of the Grafana workspace. */
    resourceGroup: string;
    /** Location of the integration fabric. */
    location: string;
    /** ARM ID of the integrated resource. */
    targetResourceId: string | undefined;
    /** ARM ID of the data source resource. */
    dataSourceResourceId: string | undefined;
    /** Enabled integration scenarios. */
    scenarios: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An integration fabric of an Azure Managed Grafana workspace — wires an
 * Azure Monitor workspace data source into Grafana for integration
 * scenarios (e.g. `aks`, `istio`) so Grafana ships curated dashboards for it.
 *
 * @see https://learn.microsoft.com/azure/managed-grafana/overview
 *
 * ### Integrating AKS Dashboards
 * **Example:** AKS and Istio dashboards over an Azure Monitor workspace
 * ```typescript
 * const fabric = yield* Azure.Grafana.IntegrationFabric("aks", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: grafana.workspaceName,
 *   dataSourceResourceId: metrics.workspaceId,
 *   scenarios: ["aks", "istio"],
 * });
 * ```
 *
 * @resource
 */
export const IntegrationFabric = Resource<IntegrationFabric>(
  "Azure.Grafana.IntegrationFabric",
);

const getFabric = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  integrationFabricName: string,
) =>
  orUndefinedIfNotFound(
    dashboard.GetIntegrationFabric({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      integrationFabricName,
    }),
  );

const lower = (value: string | undefined) =>
  value?.toLowerCase().replaceAll(" ", "") || undefined;

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  fabric: dashboard.GetIntegrationFabricResponse | dashboard.IntegrationFabric,
): IntegrationFabric["Attributes"] => ({
  integrationFabricName: name,
  integrationFabricId: fabric.id ?? "",
  workspace,
  resourceGroup,
  location: fabric.location,
  targetResourceId: fabric.properties?.targetResourceId || undefined,
  dataSourceResourceId: fabric.properties?.dataSourceResourceId || undefined,
  scenarios: [...(fabric.properties?.scenarios ?? [])],
  tags: userTags(fabric.tags),
});

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  const left = new Set(a.map((value) => value.toLowerCase()));
  const right = new Set(b.map((value) => value.toLowerCase()));
  return left.size === right.size && [...left].every((v) => right.has(v));
};

// Integration fabric names match ^[a-zA-Z][a-z0-9A-Z-]{0,18}[a-z0-9A-Z]$.
const createFabricName = (id: string) => createGrafanaName(id, 20);

const BUDGET = { interval: "5 seconds", times: 60 } as const;

export const IntegrationFabricProvider = () =>
  Provider.succeed(IntegrationFabric, {
    stables: [
      "integrationFabricName",
      "integrationFabricId",
      "workspace",
      "resourceGroup",
      "location",
      "targetResourceId",
      "dataSourceResourceId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const workspaces = yield* orUndefinedIfNotFound(
        dashboard.ListGrafana({ subscriptionId }),
      );
      if (workspaces === undefined) return [];
      yield* requireSinglePage("ListGrafana", workspaces);
      const found: IntegrationFabric["Attributes"][] = [];
      for (const grafana of workspaces.value ?? []) {
        const group = resourceGroupOf(grafana.id);
        if (group === undefined || grafana.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          dashboard.ListIntegrationFabrics({
            subscriptionId,
            resourceGroupName: group,
            workspaceName: grafana.name,
          }),
        );
        if (page === undefined) continue;
        yield* requireSinglePage("ListIntegrationFabrics", page);
        for (const fabric of page.value ?? []) {
          if (hasAnyAlchemyTag(fabric.tags) && fabric.name !== undefined) {
            found.push(toAttrs(group, grafana.name, fabric.name, fabric));
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
          lower(news.name) !== lower(output.integrationFabricName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        lower(news.targetResourceId) !== lower(output.targetResourceId) ||
        lower(news.dataSourceResourceId) !== lower(output.dataSourceResourceId)
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
        output?.integrationFabricName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getFabric(
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
        output?.integrationFabricName ??
        (yield* createFabricName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        integrationFabricName: name,
      };
      const get = getFabric(subscriptionId, resourceGroup, workspace, name);
      const label = `Grafana integration fabric ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. The fabric lives in its workspace's location.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getGrafana(subscriptionId, resourceGroup, workspace))
            ?.location ??
          env.location;
        yield* dashboard.CreateIntegrationFabric({
          ...where,
          location,
          tags,
          properties: {
            targetResourceId: news.targetResourceId,
            dataSourceResourceId: news.dataSourceResourceId,
            scenarios: news.scenarios,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (fabric) => fabric.properties?.provisioningState,
        BUDGET,
      );

      // Sync scenarios and tags against observed state.
      const scenariosChanged =
        news.scenarios !== undefined &&
        !sameSet(news.scenarios, observed.properties?.scenarios ?? []);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (scenariosChanged || tagsChanged) {
        yield* dashboard.UpdateIntegrationFabric({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: scenariosChanged
            ? { scenarios: news.scenarios }
            : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (fabric) =>
            tagsDiffer(fabric.tags, tags) ||
            (news.scenarios !== undefined &&
              !sameSet(news.scenarios, fabric.properties?.scenarios ?? []))
              ? "Updating"
              : fabric.properties?.provisioningState,
          BUDGET,
        );
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dashboard.DeleteIntegrationFabric({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          integrationFabricName: output.integrationFabricName,
        }),
      );
      yield* waitUntilGone(
        `Grafana integration fabric ${output.integrationFabricName}`,
        getFabric(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.integrationFabricName,
        ),
        BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Grafana.Workspace"],
    },
  });
