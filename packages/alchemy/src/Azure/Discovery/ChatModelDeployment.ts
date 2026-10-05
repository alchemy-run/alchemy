import * as discovery from "@distilled.cloud/azure/discovery";
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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createDiscoveryName,
  DISCOVERY_NAMESPACE,
  lower,
  sameLocation,
} from "./common.ts";
import { getWorkspace } from "./Workspace.ts";

export interface ChatModelDeploymentProps {
  /** Resource group of the parent workspace. Changing it replaces the deployment. */
  resourceGroup: string;
  /** Name of the parent workspace. Changing it replaces the deployment. */
  workspace: string;
  /**
   * Deployment name: 3-24 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the deployment.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the deployment.
   * @default the parent workspace's location
   */
  location?: string;
  /** Model format, e.g. `OpenAI`. Changing it replaces the deployment. */
  modelFormat: string;
  /** Model name, e.g. `gpt-4o`. Changing it replaces the deployment. */
  modelName: string;
  /** Model version. Changing it replaces the deployment. */
  modelVersion?: string;
  /** SKU tier, e.g. `GlobalStandard`. Changing it replaces the deployment. */
  skuName?: string;
  /** Provisioned capacity units (thousands of tokens per minute). */
  capacity?: number;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ChatModelDeployment extends Resource<
  "Azure.Discovery.ChatModelDeployment",
  ChatModelDeploymentProps,
  {
    /** Name of the chat model deployment. */
    chatModelDeploymentName: string;
    /** ARM resource ID of the chat model deployment. */
    chatModelDeploymentId: string;
    /** Name of the parent workspace. */
    workspace: string;
    /** Resource group that holds the deployment. */
    resourceGroup: string;
    /** Location of the deployment. */
    location: string;
    /** Model format. */
    modelFormat: string;
    /** Model name. */
    modelName: string;
    /** Model version. */
    modelVersion: string | undefined;
    /** SKU tier. */
    skuName: string | undefined;
    /** Provisioned capacity units. */
    capacity: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Discovery chat model deployment
 * (`Microsoft.Discovery/workspaces/chatModelDeployments`) — binds a Foundry
 * chat model to a deployment name that the workspace's agents use for
 * inference. Consumes Azure OpenAI quota.
 *
 * Microsoft Discovery is a gated preview: on subscriptions without the
 * preview, ARM rejects the resource type with `InvalidResourceType`.
 *
 * @see https://learn.microsoft.com/azure/microsoft-discovery/
 *
 * ### Deploying a Chat Model
 * **Example:** GPT-4o deployment
 * ```typescript
 * const chat = yield* Azure.Discovery.ChatModelDeployment("gpt", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   modelFormat: "OpenAI",
 *   modelName: "gpt-4o",
 *   skuName: "GlobalStandard",
 *   capacity: 10,
 * });
 * ```
 *
 * @resource
 */
export const ChatModelDeployment = Resource<ChatModelDeployment>(
  "Azure.Discovery.ChatModelDeployment",
);

const getDeployment = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  chatModelDeploymentName: string,
) =>
  orUndefinedIfNotFound(
    discovery.GetChatModelDeployment({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      chatModelDeploymentName,
    }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  observed: discovery.GetChatModelDeploymentResponse,
): ChatModelDeployment["Attributes"] => ({
  chatModelDeploymentName: name,
  chatModelDeploymentId: observed.id ?? "",
  workspace,
  resourceGroup,
  location: observed.location,
  modelFormat: observed.properties?.modelFormat ?? "",
  modelName: observed.properties?.modelName ?? "",
  modelVersion: observed.properties?.modelVersion,
  skuName: observed.properties?.skuName,
  capacity: observed.properties?.capacity,
  tags: userTags(observed.tags),
});

export const ChatModelDeploymentProvider = () =>
  Provider.succeed(ChatModelDeployment, {
    stables: [
      "chatModelDeploymentName",
      "chatModelDeploymentId",
      "workspace",
      "resourceGroup",
      "location",
      "modelFormat",
      "modelName",
    ],

    // Deployments live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspace) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.chatModelDeploymentName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.modelFormat) !== lower(output.modelFormat) ||
        lower(news.modelName) !== lower(output.modelName) ||
        (news.modelVersion !== undefined &&
          news.modelVersion !== output.modelVersion) ||
        (news.skuName !== undefined &&
          lower(news.skuName) !== lower(output.skuName))
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
        output?.chatModelDeploymentName ??
        olds?.name ??
        (yield* createDiscoveryName(id));
      const observed = yield* getDeployment(
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
      yield* ensureRegistered(subscriptionId, DISCOVERY_NAMESPACE);
      const { resourceGroup, workspace } = news;
      const name =
        news.name ??
        output?.chatModelDeploymentName ??
        (yield* createDiscoveryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        chatModelDeploymentName: name,
      };
      const get = getDeployment(subscriptionId, resourceGroup, workspace, name);
      const ready = waitForProvisioned(
        `discovery chat model deployment ${name}`,
        get,
        (deployment) => deployment.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getWorkspace(subscriptionId, resourceGroup, workspace))
            ?.location ??
          env.location;
        yield* discovery.ChatModelDeploymentsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            modelFormat: news.modelFormat,
            modelName: news.modelName,
            modelVersion: news.modelVersion,
            skuName: news.skuName,
            capacity: news.capacity,
          },
        });
      }
      observed = yield* ready;

      // Sync capacity and tags with a PATCH of the deltas.
      const capacityChanged =
        news.capacity !== undefined &&
        observed.properties?.capacity !== news.capacity;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (capacityChanged || tagsChanged) {
        yield* discovery.UpdateChatModelDeployment({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: capacityChanged ? { capacity: news.capacity } : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        discovery.DeleteChatModelDeployment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          chatModelDeploymentName: output.chatModelDeploymentName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `discovery chat model deployment ${output.chatModelDeploymentName}`,
        getDeployment(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.chatModelDeploymentName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Discovery.Workspace", "Azure.Resources.ResourceGroup"],
    },
  });
