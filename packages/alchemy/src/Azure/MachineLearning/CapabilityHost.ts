import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createChildName, sameArm, sameValue } from "./Common.ts";

export interface CapabilityHostProps {
  /** Resource group of the workspace. Changing it replaces the capability host. */
  resourceGroup: string;
  /**
   * Hub or project workspace that owns the capability host. Changing it
   * replaces the capability host.
   */
  workspace: string;
  /**
   * Capability host name. If omitted, a unique name is generated from the
   * logical ID. Changing it replaces the capability host.
   */
  name?: string;
  /**
   * Kind of capability the host provides. Changing it replaces the
   * capability host.
   * @default "Agents"
   */
  capabilityHostKind?: "Agents";
  /**
   * ARM resource ID of a subnet for network-injected agents. Changing it
   * replaces the capability host.
   */
  customerSubnet?: string;
  /**
   * Connection names of Azure AI Services / Azure OpenAI used by agents.
   * Changing them replaces the capability host.
   */
  aiServicesConnections?: string[];
  /**
   * Connection names of storage accounts for agent files. Changing them
   * replaces the capability host.
   */
  storageConnections?: string[];
  /**
   * Connection names of Cosmos DB accounts for agent threads. Changing them
   * replaces the capability host.
   */
  threadStorageConnections?: string[];
  /**
   * Connection names of AI Search services for vector stores. Changing them
   * replaces the capability host.
   */
  vectorStoreConnections?: string[];
  /**
   * Connection names of Container Apps environments. Changing them replaces
   * the capability host.
   */
  acaEnvironmentConnections?: string[];
  /** Description of the capability host. Changing it replaces the capability host. */
  description?: string;
  /**
   * User tags (stored in the capability host body). Alchemy ownership tags
   * are merged in automatically. Changing them replaces the capability host.
   */
  tags?: Record<string, string>;
}

export interface CapabilityHost extends Resource<
  "Azure.MachineLearning.CapabilityHost",
  CapabilityHostProps,
  {
    /** Name of the capability host. */
    capabilityHostName: string;
    /** ARM resource ID of the capability host. */
    capabilityHostId: string;
    /** Workspace that owns the capability host. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Kind of capability the host provides. */
    capabilityHostKind: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A capability host of an Azure AI Foundry hub or project workspace — it
 * binds the Agents service to the connections that hold agent threads,
 * files, and vector stores (bring-your-own Cosmos DB, storage, and AI
 * Search). The service rejects updates, so every change replaces it.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/agents/concepts/capability-hosts
 *
 * ### Agents
 * **Example:** Standard agent setup on a project
 * ```typescript
 * const host = yield* Azure.MachineLearning.CapabilityHost("agents", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: project.workspaceName,
 *   aiServicesConnections: [openai.connectionName],
 *   storageConnections: [files.connectionName],
 *   threadStorageConnections: [cosmos.connectionName],
 *   vectorStoreConnections: [search.connectionName],
 * });
 * ```
 *
 * @resource
 */
export const CapabilityHost = Resource<CapabilityHost>(
  "Azure.MachineLearning.CapabilityHost",
);

const getHost = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    ml.GetCapabilityHost({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  host: ml.GetCapabilityHostResponse,
): CapabilityHost["Attributes"] => ({
  capabilityHostName: name,
  capabilityHostId: host.id ?? "",
  workspace,
  resourceGroup,
  capabilityHostKind: host.properties.capabilityHostKind ?? undefined,
  tags: userTags(host.properties.tags ?? undefined),
});

const definition = (props: CapabilityHostProps) => ({
  capabilityHostKind: props.capabilityHostKind ?? "Agents",
  customerSubnet: props.customerSubnet,
  aiServicesConnections: props.aiServicesConnections,
  storageConnections: props.storageConnections,
  threadStorageConnections: props.threadStorageConnections,
  vectorStoreConnections: props.vectorStoreConnections,
  acaEnvironmentConnections: props.acaEnvironmentConnections,
  description: props.description,
  tags: props.tags,
});

export const CapabilityHostProvider = () =>
  Provider.succeed(CapabilityHost, {
    stables: [
      "capabilityHostName",
      "capabilityHostId",
      "workspace",
      "resourceGroup",
    ],

    // Capability hosts are deleted with their workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news.resourceGroup) || !isResolved(news.workspace)) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      // The service rejects updates: any change replaces the host.
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined && news.name !== output.capabilityHostName) ||
        (olds !== undefined && !sameValue(definition(news), definition(olds)))
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
        output?.capabilityHostName ??
        olds?.name ??
        (yield* createChildName(id, 64));
      const observed = yield* getHost(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, observed.properties.tags ?? undefined))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.MachineLearningServices",
      );
      const { resourceGroup, workspace } = news;
      const name =
        news.name ??
        output?.capabilityHostName ??
        (yield* createChildName(id, 64));
      const tags = yield* desiredTags(id, news.tags);
      const get = getHost(subscriptionId, resourceGroup, workspace, name);

      // Observe.
      const observed = yield* get;

      // Ensure. Updates are rejected by the service (changes replace the
      // host in diff); an adopted host only has its ownership tags checked.
      if (observed === undefined) {
        yield* ml.CapabilityHostsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          name,
          properties: { ...definition(news), tags },
        });
      }

      const fresh = yield* waitForProvisioned(
        `machine learning capability host ${name}`,
        get,
        (host) => host.properties.provisioningState,
        { interval: "5 seconds", times: 90 },
      );
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteCapabilityHost({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          name: output.capabilityHostName,
        }),
      );
      yield* waitUntilGone(
        `machine learning capability host ${output.capabilityHostName}`,
        getHost(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.capabilityHostName,
        ),
        { interval: "5 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.MachineLearning.Workspace"] },
  });
