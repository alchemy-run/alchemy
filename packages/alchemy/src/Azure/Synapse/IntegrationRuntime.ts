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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createDnsName,
  fieldsMatch,
  isWorkspaceOwnedByStack,
  lower,
} from "./common.ts";

/** Data flow compute of a Managed (Azure) integration runtime. */
export interface IntegrationRuntimeDataFlowProperties {
  /** Compute type of the data flow cluster. */
  computeType?: "General" | "MemoryOptimized" | "ComputeOptimized";
  /** Core count of the data flow cluster (8, 16, 32, ...). */
  coreCount?: number;
  /** Minutes to keep the cluster warm after a data flow run. */
  timeToLive?: number;
  /** Release the cluster after `timeToLive` instead of reusing it. */
  cleanup?: boolean;
}

/** Compute of a Managed (Azure) integration runtime. */
export interface IntegrationRuntimeComputeProperties {
  /**
   * Location of the compute, or `AutoResolve` to use the region closest to
   * the data.
   * @default "AutoResolve"
   */
  location?: string;
  /** Data flow compute settings. */
  dataFlowProperties?: IntegrationRuntimeDataFlowProperties;
}

export interface IntegrationRuntimeProps {
  /** Resource group of the workspace. Changing it replaces the runtime. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the runtime. */
  workspace: string;
  /**
   * Runtime name: 3-63 letters, digits, and hyphens, starting and ending
   * with a letter or digit. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the runtime.
   */
  name?: string;
  /**
   * `Managed` (Azure-hosted compute) or `SelfHosted` (your own nodes).
   * Changing it replaces the runtime.
   */
  type: "Managed" | "SelfHosted";
  /** Description of the runtime. */
  description?: string;
  /** Compute settings of a `Managed` runtime. */
  computeProperties?: IntegrationRuntimeComputeProperties;
  /**
   * Run a `Managed` runtime in the workspace's managed virtual network
   * (requires a workspace with `managedVirtualNetwork: true`). Changing it
   * replaces the runtime.
   * @default false
   */
  managedVirtualNetwork?: boolean;
}

export interface IntegrationRuntime extends Resource<
  "Azure.Synapse.IntegrationRuntime",
  IntegrationRuntimeProps,
  {
    /** Name of the runtime. */
    integrationRuntimeName: string;
    /** ARM resource ID of the runtime. */
    integrationRuntimeId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** `Managed` or `SelfHosted`. */
    type: string;
    /** Runtime state, e.g. `Initial`, `Started`, `NeedRegistration`. */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An integration runtime in a Synapse workspace — the compute that
 * pipelines and data flows run on. A `Managed` runtime is Azure-hosted and
 * billed only while activities run; a `SelfHosted` runtime is a
 * registration that your own nodes join with its authentication key.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/data-integration/concepts-data-factory-differences
 *
 * ### Managed Runtimes
 * **Example:** Azure-hosted runtime with a data flow cluster
 * ```typescript
 * yield* Azure.Synapse.IntegrationRuntime("flows", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   type: "Managed",
 *   computeProperties: {
 *     location: "AutoResolve",
 *     dataFlowProperties: { computeType: "General", coreCount: 8, timeToLive: 10 },
 *   },
 * });
 * ```
 *
 * ### Self-Hosted Runtimes
 * **Example:** Self-hosted runtime registration
 * ```typescript
 * yield* Azure.Synapse.IntegrationRuntime("onprem", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   type: "SelfHosted",
 *   description: "On-premises SQL Server gateway",
 * });
 * ```
 *
 * @resource
 */
export const IntegrationRuntime = Resource<IntegrationRuntime>(
  "Azure.Synapse.IntegrationRuntime",
);

type ObservedRuntime = synapse.GetIntegrationRuntimeResponse;

const createRuntimeName = (id: string) => createDnsName(id, 63);

const getRuntime = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  integrationRuntimeName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetIntegrationRuntime({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      integrationRuntimeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  name: string,
  runtime: ObservedRuntime,
): IntegrationRuntime["Attributes"] => ({
  integrationRuntimeName: name,
  integrationRuntimeId: runtime.id ?? "",
  workspaceName,
  resourceGroup,
  type: runtime.properties?.type ?? "",
  state: runtime.properties?.state,
});

const desiredRuntime = (
  news: IntegrationRuntimeProps,
): synapse.IntegrationRuntime =>
  news.type === "Managed"
    ? {
        type: "Managed",
        description: news.description,
        typeProperties: {
          computeProperties: {
            ...news.computeProperties,
            location: news.computeProperties?.location ?? "AutoResolve",
          },
        },
        managedVirtualNetwork: news.managedVirtualNetwork
          ? {
              referenceName: "default",
              type: "ManagedVirtualNetworkReference",
            }
          : undefined,
      }
    : { type: "SelfHosted", description: news.description };

export const IntegrationRuntimeProvider = () =>
  Provider.succeed(IntegrationRuntime, {
    stables: [
      "integrationRuntimeName",
      "integrationRuntimeId",
      "workspaceName",
      "resourceGroup",
      "type",
    ],

    // Runtimes live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspaceName) ||
        (news.name !== undefined &&
          news.name !== output.integrationRuntimeName) ||
        lower(news.type) !== lower(output.type) ||
        (olds !== undefined &&
          (news.managedVirtualNetwork ?? false) !==
            (olds.managedVirtualNetwork ?? false))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspaceName ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.integrationRuntimeName ??
        olds?.name ??
        (yield* createRuntimeName(id));
      const observed = yield* getRuntime(
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

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const { resourceGroup, workspace } = news;
      const name =
        news.name ??
        output?.integrationRuntimeName ??
        (yield* createRuntimeName(id));
      const desired = desiredRuntime(news);
      const get = getRuntime(subscriptionId, resourceGroup, workspace, name);
      const matches = (runtime: ObservedRuntime) =>
        fieldsMatch(runtime.properties, desired);

      // Observe, then create or converge in one long-running PUT.
      const observed = yield* get;
      if (observed === undefined || !matches(observed)) {
        yield* synapse.CreateIntegrationRuntime({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          integrationRuntimeName: name,
          properties: desired,
        });
      }

      const fresh = yield* waitForProvisioned(
        `synapse integration runtime ${name}`,
        get,
        (runtime) => (matches(runtime) ? "Succeeded" : "Updating"),
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        synapse.DeleteIntegrationRuntime({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspaceName,
          integrationRuntimeName: output.integrationRuntimeName,
        }),
      );
      yield* waitUntilGone(
        `synapse integration runtime ${output.integrationRuntimeName}`,
        getRuntime(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
          output.integrationRuntimeName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
