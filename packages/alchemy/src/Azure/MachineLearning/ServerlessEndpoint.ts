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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  identityDiffers,
  type MachineLearningIdentity,
  sameArm,
  toArmIdentity,
  workspaceLocation,
} from "./Common.ts";

export interface ServerlessEndpointProps {
  /** Resource group of the workspace. Changing it replaces the endpoint. */
  resourceGroup: string;
  /** Project workspace that owns the endpoint. Changing it replaces the endpoint. */
  workspace: string;
  /**
   * Endpoint name: 3-32 letters, digits, and hyphens, starting with a
   * letter. If omitted, a unique name is generated from the logical ID.
   * Changing it replaces the endpoint.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the endpoint.
   * @default the workspace's location
   */
  location?: string;
  /**
   * Model to serve, e.g.
   * `azureml://registries/azureml-meta/models/Meta-Llama-3-8B-Instruct`.
   * Non-Microsoft models need a marketplace subscription. Changing it
   * replaces the endpoint.
   */
  modelId: string;
  /**
   * Azure AI Content Safety filtering of prompts and completions.
   * @default Azure's default
   */
  contentSafety?: "Enabled" | "Disabled";
  /** Managed identity of the endpoint. */
  identity?: MachineLearningIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ServerlessEndpoint extends Resource<
  "Azure.MachineLearning.ServerlessEndpoint",
  ServerlessEndpointProps,
  {
    /** Name of the endpoint. */
    endpointName: string;
    /** ARM resource ID of the endpoint. */
    endpointId: string;
    /** Workspace that owns the endpoint. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Location of the endpoint. */
    location: string;
    /** Model the endpoint serves. */
    modelId: string | undefined;
    /** Inference URI clients call. */
    inferenceUri: string | undefined;
    /** Marketplace subscription backing the endpoint, if any. */
    marketplaceSubscriptionId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A serverless (models-as-a-service) endpoint in an Azure AI Foundry
 * project: a pay-per-token API for a catalog model with no compute to
 * manage. Non-Microsoft models need a marketplace subscription in the
 * project first.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/how-to/deploy-models-serverless
 *
 * ### Deploying a Model
 * **Example:** Serverless endpoint for a catalog model
 * ```typescript
 * const llama = yield* Azure.MachineLearning.ServerlessEndpoint("llama", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: project.workspaceName,
 *   modelId: "azureml://registries/azureml-meta/models/Meta-Llama-3-8B-Instruct",
 * });
 * ```
 *
 * **Example:** Endpoint without content safety filtering
 * ```typescript
 * const phi = yield* Azure.MachineLearning.ServerlessEndpoint("phi", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: project.workspaceName,
 *   modelId: "azureml://registries/azureml/models/Phi-3-mini-4k-instruct",
 *   contentSafety: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const ServerlessEndpoint = Resource<ServerlessEndpoint>(
  "Azure.MachineLearning.ServerlessEndpoint",
);

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    ml.GetServerlessEndpoint({
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
  endpoint: ml.GetServerlessEndpointResponse,
): ServerlessEndpoint["Attributes"] => ({
  endpointName: name,
  endpointId: endpoint.id ?? "",
  workspace,
  resourceGroup,
  location: endpoint.location,
  modelId: endpoint.properties.modelSettings?.modelId ?? undefined,
  inferenceUri: endpoint.properties.inferenceEndpoint?.uri,
  marketplaceSubscriptionId:
    endpoint.properties.marketplaceSubscriptionId ?? undefined,
  tags: userTags(endpoint.tags),
});

export const ServerlessEndpointProvider = () =>
  Provider.succeed(ServerlessEndpoint, {
    stables: [
      "endpointName",
      "endpointId",
      "workspace",
      "resourceGroup",
      "location",
    ],

    // Endpoints are deleted with their workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news.resourceGroup) || !isResolved(news.workspace)) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined && news.name !== output.endpointName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.modelId, output.modelId)
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
        output?.endpointName ?? olds?.name ?? (yield* createChildName(id, 32));
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
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.MachineLearningServices",
      );
      const { resourceGroup, workspace } = news;
      const name =
        news.name ?? output?.endpointName ?? (yield* createChildName(id, 32));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        name,
      };
      const get = getEndpoint(subscriptionId, resourceGroup, workspace, name);
      const label = `machine learning serverless endpoint ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure + sync content safety (PUT of the whole endpoint).
      if (
        observed === undefined ||
        (news.contentSafety !== undefined &&
          observed.properties.contentSafety?.contentSafetyStatus !==
            news.contentSafety)
      ) {
        const location =
          news.location ??
          output?.location ??
          observed?.location ??
          (yield* workspaceLocation(subscriptionId, resourceGroup, workspace));
        yield* ml.ServerlessEndpointsCreateOrUpdate({
          ...where,
          location,
          tags,
          sku: { name: "Consumption" },
          identity: toArmIdentity(news.identity),
          properties: {
            authMode: "Key",
            modelSettings: { modelId: news.modelId },
            contentSafety:
              news.contentSafety === undefined
                ? undefined
                : { contentSafetyStatus: news.contentSafety },
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (endpoint) => endpoint.properties.provisioningState,
        { interval: "5 seconds", times: 90 },
      );

      // Sync tags and identity (PATCH).
      if (
        tagsDiffer(observed.tags, tags) ||
        identityDiffers(observed.identity, news.identity)
      ) {
        yield* ml.UpdateServerlessEndpoint({
          ...where,
          tags,
          identity: toArmIdentity(news.identity),
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (endpoint) => {
            const state = endpoint.properties.provisioningState;
            if (state !== undefined && state !== "Succeeded") return state;
            return tagsDiffer(endpoint.tags, tags) ? "Updating" : "Succeeded";
          },
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteServerlessEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          name: output.endpointName,
        }),
      );
      yield* waitUntilGone(
        `machine learning serverless endpoint ${output.endpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.endpointName,
        ),
        { interval: "5 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.MachineLearning.Workspace"] },
  });
