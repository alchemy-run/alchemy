import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Effect from "effect/Effect";
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
import { createChildName, sameArm, inputFields } from "./Common.ts";

export interface MarketplaceSubscriptionProps {
  /** Resource group of the workspace. Changing it replaces the subscription. */
  resourceGroup: string;
  /**
   * Project workspace that owns the subscription. Changing it replaces the
   * subscription.
   */
  workspace: string;
  /**
   * Subscription name: letters, digits, and hyphens, starting with a
   * letter. If omitted, a unique name is generated from the logical ID.
   * Changing it replaces the subscription.
   */
  name?: string;
  /**
   * Catalog model to subscribe to, e.g.
   * `azureml://registries/azureml-meta/models/Meta-Llama-3-8B-Instruct`.
   * Changing it replaces the subscription.
   */
  modelId: string;
}

export interface MarketplaceSubscription extends Resource<
  "Azure.MachineLearning.MarketplaceSubscription",
  MarketplaceSubscriptionProps,
  {
    /** Name of the marketplace subscription. */
    marketplaceSubscriptionName: string;
    /** ARM resource ID of the marketplace subscription. */
    marketplaceSubscriptionId: string;
    /** Workspace that owns the subscription. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Model the subscription is for. */
    modelId: string;
    /** Marketplace status: `Subscribed`, `Suspended`, or `Unsubscribed`. */
    status: string | undefined;
    /** Marketplace offer of the model's plan. */
    offerId: string | undefined;
    /** Marketplace plan of the model. */
    planId: string | undefined;
    /** Marketplace publisher of the model. */
    publisherId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Marketplace subscription in an Azure AI Foundry project: the
 * purchase of a non-Microsoft catalog model's offer (Meta Llama, Mistral,
 * Cohere, ...) that a serverless endpoint for that model requires. The
 * subscription has no tags, so the deterministic name is its ownership
 * marker.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/how-to/deploy-models-serverless
 *
 * ### Subscribing to a Model
 * **Example:** Marketplace subscription for a catalog model
 * ```typescript
 * const subscription = yield* Azure.MachineLearning.MarketplaceSubscription(
 *   "llama",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     workspace: project.workspaceName,
 *     modelId: "azureml://registries/azureml-meta/models/Meta-Llama-3-8B-Instruct",
 *   },
 * );
 * ```
 *
 * **Example:** Serverless endpoint backed by the subscription
 * ```typescript
 * const modelId =
 *   "azureml://registries/azureml-meta/models/Meta-Llama-3-8B-Instruct";
 * const subscription = yield* Azure.MachineLearning.MarketplaceSubscription(
 *   "llama",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     workspace: project.workspaceName,
 *     modelId,
 *   },
 * );
 * const endpoint = yield* Azure.MachineLearning.ServerlessEndpoint("llama", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: subscription.workspace,
 *   modelId,
 * });
 * ```
 *
 * @resource
 */
export const MarketplaceSubscription = Resource<MarketplaceSubscription>(
  "Azure.MachineLearning.MarketplaceSubscription",
);

const getSubscription = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    ml.GetMarketplaceSubscription({
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
  observed: ml.GetMarketplaceSubscriptionResponse,
): MarketplaceSubscription["Attributes"] => ({
  marketplaceSubscriptionName: name,
  marketplaceSubscriptionId: observed.id ?? "",
  workspace,
  resourceGroup,
  modelId: observed.properties.modelId,
  status: observed.properties.marketplaceSubscriptionStatus,
  offerId: observed.properties.marketplacePlan?.offerId ?? undefined,
  planId: observed.properties.marketplacePlan?.planId ?? undefined,
  publisherId: observed.properties.marketplacePlan?.publisherId ?? undefined,
});

export const MarketplaceSubscriptionProvider = () =>
  Provider.succeed(MarketplaceSubscription, {
    stables: [
      "marketplaceSubscriptionName",
      "marketplaceSubscriptionId",
      "workspace",
      "resourceGroup",
      "modelId",
    ],

    // Marketplace subscriptions are deleted with their workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      const fields = inputFields(news);
      if (
        fields === undefined ||
        !isResolved(fields.resourceGroup) ||
        !isResolved(fields.workspace)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined &&
          news.name !== output.marketplaceSubscriptionName) ||
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
        output?.marketplaceSubscriptionName ??
        olds?.name ??
        (yield* createChildName(id, 32));
      const observed = yield* getSubscription(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      // No tags or metadata: the deterministic name is the only ownership
      // signal, so an existing subscription under it is ours.
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, workspace, name, observed);
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
        output?.marketplaceSubscriptionName ??
        (yield* createChildName(id, 32));
      const get = getSubscription(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. The model is the only property and is immutable (diff
      // replaces), so an existing subscription needs no sync.
      if (observed === undefined) {
        yield* ml.MarketplaceSubscriptionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          name,
          properties: { modelId: news.modelId },
        });
      }
      const ready = yield* waitForProvisioned(
        `machine learning marketplace subscription ${name}`,
        get,
        (subscription) => subscription.properties.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      return toAttrs(resourceGroup, workspace, name, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteMarketplaceSubscription({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          name: output.marketplaceSubscriptionName,
        }),
      );
      yield* waitUntilGone(
        `machine learning marketplace subscription ${output.marketplaceSubscriptionName}`,
        getSubscription(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.marketplaceSubscriptionName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.MachineLearning.Workspace"] },
  });
