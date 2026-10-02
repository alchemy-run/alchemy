import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
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
  ACCOUNT_BUDGET,
  createChildName,
  sameArm,
  whileAccountBusy,
} from "./Common.ts";

export interface DeploymentModel {
  /** Model format, e.g. `OpenAI`, `Microsoft`, `Meta`. Changing it replaces the deployment. */
  format: string;
  /** Model name, e.g. `gpt-4o-mini`. Changing it replaces the deployment. */
  name: string;
  /** Model version, e.g. `2024-07-18`. If omitted, the default version is used. */
  version?: string;
}

export interface DeploymentSku {
  /**
   * Deployment type: `Standard`, `GlobalStandard`, `DataZoneStandard`,
   * `GlobalBatch`, `ProvisionedManaged`, ...
   */
  name: string;
  /** Capacity in units of the SKU (thousands of tokens per minute for Standard types). */
  capacity?: number;
}

export interface DeploymentProps {
  /** Resource group of the account. Changing it replaces the deployment. */
  resourceGroup: string;
  /**
   * Account (kind `OpenAI` or `AIServices`) that holds the deployment.
   * Changing it replaces the deployment.
   */
  account: string;
  /**
   * Deployment name, used by clients as the model ID. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the deployment.
   */
  name?: string;
  /** Model to deploy. */
  model: DeploymentModel;
  /**
   * Deployment type and capacity.
   * @default { name: "GlobalStandard", capacity: 1 }
   */
  sku?: DeploymentSku;
  /** Name of a `CognitiveServices.RaiPolicy` (content filter) to apply. */
  raiPolicyName?: string;
  /**
   * When to upgrade the model version.
   * @default Azure's default (`OnceNewDefaultVersionAvailable`)
   */
  versionUpgradeOption?:
    | "OnceNewDefaultVersionAvailable"
    | "OnceCurrentVersionExpired"
    | "NoAutoUpgrade";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Deployment extends Resource<
  "Azure.CognitiveServices.Deployment",
  DeploymentProps,
  {
    /** Name of the deployment (the model ID clients send). */
    deploymentName: string;
    /** ARM resource ID of the deployment. */
    deploymentId: string;
    /** Account that holds the deployment. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Model format. */
    modelFormat: string;
    /** Model name. */
    modelName: string;
    /** Deployed model version. */
    modelVersion: string | undefined;
    /** Deployment type. */
    sku: string;
    /** Capacity. */
    capacity: number | undefined;
    /** Applied content-filter policy. */
    raiPolicyName: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A model deployment (`Microsoft.CognitiveServices/accounts/deployments`)
 * of an Azure OpenAI or Azure AI Foundry account — e.g. `gpt-4o-mini` with
 * `GlobalStandard` capacity — addressed by clients through its name.
 *
 * Deployments consume model quota (tokens per minute) of the subscription
 * and region; Azure free trial subscriptions have none.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/openai/how-to/create-resource
 *
 * ### Deploying a Model
 * **Example:** gpt-4o-mini, global standard
 * ```typescript
 * const chat = yield* Azure.CognitiveServices.Deployment("chat", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   model: { format: "OpenAI", name: "gpt-4o-mini", version: "2024-07-18" },
 *   sku: { name: "GlobalStandard", capacity: 10 },
 * });
 * ```
 *
 * ### Content Filtering
 * **Example:** Apply a custom RAI policy
 * ```typescript
 * const chat = yield* Azure.CognitiveServices.Deployment("chat", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   model: { format: "OpenAI", name: "gpt-4o-mini" },
 *   raiPolicyName: policy.raiPolicyName,
 * });
 * ```
 *
 * @resource
 */
export const Deployment = Resource<Deployment>(
  "Azure.CognitiveServices.Deployment",
);

const getDeployment = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  deploymentName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetDeployment({
      subscriptionId,
      resourceGroupName,
      accountName,
      deploymentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  deployment: cognitiveservices.GetDeploymentResponse,
): Deployment["Attributes"] => ({
  deploymentName: name,
  deploymentId: deployment.id ?? "",
  account,
  resourceGroup,
  modelFormat: deployment.properties?.model?.format ?? "",
  modelName: deployment.properties?.model?.name ?? "",
  modelVersion: deployment.properties?.model?.version,
  sku: deployment.sku?.name ?? "",
  capacity: deployment.sku?.capacity,
  raiPolicyName: deployment.properties?.raiPolicyName,
  tags: userTags(deployment.tags),
});

export const DeploymentProvider = () =>
  Provider.succeed(Deployment, {
    stables: [
      "deploymentName",
      "deploymentId",
      "account",
      "resourceGroup",
      "modelFormat",
      "modelName",
    ],

    // Deployments live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.deploymentName)) ||
        !sameArm(news.model.format, output.modelFormat) ||
        !sameArm(news.model.name, output.modelName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.deploymentName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getDeployment(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.deploymentName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? { name: "GlobalStandard", capacity: 1 };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        deploymentName: name,
      };
      const label = `model deployment ${name}`;
      const get = getDeployment(subscriptionId, resourceGroup, account, name);

      // Observe.
      let observed = yield* get;

      // Ensure + sync model settings: the PUT is a full upsert (LRO), sent
      // when the deployment is missing or a model setting differs.
      const props = observed?.properties;
      if (
        observed === undefined ||
        (news.model.version !== undefined &&
          props?.model?.version !== news.model.version) ||
        (news.raiPolicyName !== undefined &&
          props?.raiPolicyName !== news.raiPolicyName) ||
        (news.versionUpgradeOption !== undefined &&
          props?.versionUpgradeOption !== news.versionUpgradeOption)
      ) {
        yield* cognitiveservices
          .DeploymentsCreateOrUpdate({
            ...where,
            sku: { name: sku.name, capacity: sku.capacity },
            tags,
            properties: {
              model: {
                format: news.model.format,
                name: news.model.name,
                version: news.model.version,
              },
              raiPolicyName: news.raiPolicyName,
              versionUpgradeOption: news.versionUpgradeOption,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (deployment) => deployment.properties?.provisioningState,
        ACCOUNT_BUDGET,
      );

      // Sync SKU/capacity and tags with PATCH.
      const skuChanged =
        !sameArm(observed.sku?.name, sku.name) ||
        (sku.capacity !== undefined && observed.sku?.capacity !== sku.capacity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (skuChanged || tagsChanged) {
        yield* cognitiveservices
          .UpdateDeployment({
            ...where,
            sku: skuChanged
              ? { name: sku.name, capacity: sku.capacity }
              : undefined,
            tags: tagsChanged ? tags : undefined,
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForProvisioned(
          label,
          get,
          (deployment) => deployment.properties?.provisioningState,
          ACCOUNT_BUDGET,
        );
      }

      return toAttrs(resourceGroup, account, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteDeployment({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            deploymentName: output.deploymentName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `model deployment ${output.deploymentName}`,
        getDeployment(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.deploymentName,
        ),
        ACCOUNT_BUDGET,
      );
    }),
  });
