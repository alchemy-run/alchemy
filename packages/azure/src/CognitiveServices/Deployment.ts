import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
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
import { ACCOUNT_BUDGET, createChildName, sameArm, whileAccountBusy } from "./Common.ts";

export interface DeploymentModel {
  /**
   * Model format, e.g. `OpenAI`, `Microsoft`, `Meta`.
   *
   * :::caution
   * Changing it replaces the deployment.
   * :::
   */
  format: string;
  /**
   * Model name, e.g. `gpt-4.1-mini`.
   *
   * :::caution
   * Changing it replaces the deployment.
   * :::
   */
  name: string;
  /**
   * Model version, e.g. `2025-04-14`. Changing it upgrades the deployment
   * in place.
   * @default the model's default version
   */
  version?: string;
}

export interface DeploymentSku {
  /**
   * Deployment type: `Standard`, `GlobalStandard`, `DataZoneStandard`,
   * `GlobalBatch`, `ProvisionedManaged`, ...
   */
  name: string;
  /**
   * Capacity in units of the SKU (thousands of tokens per minute for the
   * Standard types). Changing it updates the deployment in place.
   * @default 1
   */
  capacity?: number;
}

export interface DeploymentProps {
  /**
   * Resource group of the account.
   *
   * :::caution
   * Changing it replaces the deployment.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Account (kind `OpenAI` or `AIServices`) that holds the deployment.
   *
   * :::caution
   * Changing it replaces the deployment.
   * :::
   */
  account: string;
  /**
   * Deployment name, used by clients as the model ID (`deploymentId`).
   *
   * :::caution
   * Changing it replaces the deployment. Clients that send the old name
   * fail until they switch.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /** Model to deploy. */
  model: DeploymentModel;
  /**
   * Deployment type and capacity.
   * @default { name: "GlobalStandard", capacity: 1 }
   */
  sku?: DeploymentSku;
  /**
   * Name of a `CognitiveServices.RaiPolicy` (content filter) to apply.
   * @default Azure's default content filter
   */
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
   * @default {}
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
 * of an Azure OpenAI or Azure AI Foundry account, for example `gpt-4.1-mini`
 * with `GlobalStandard` capacity. Clients address it by its name: the
 * `deploymentId` of an OpenAI binding, or `model` for Foundry agents.
 *
 * Deployments use the subscription's model quota (tokens per minute) in
 * the account's region; Azure free-trial subscriptions have none. Capacity,
 * model version, content filter, and upgrade option change in place.
 *
 * :::caution[Changing `name`, `account`, `model.format`, `model.name`, or `resourceGroup` replaces the deployment]
 * Alchemy creates the new deployment and deletes the old one. Clients that
 * send the old name fail until they switch.
 * :::
 *
 * :::caution[An account runs one deployment operation at a time]
 * Azure rejects a second create or update on the same account while one is
 * running. Alchemy retries for about two minutes; make each deployment wait
 * for the previous one (yield it first) so they do not contend.
 * :::
 *
 * See [Create and deploy an Azure OpenAI resource](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/create-resource).
 *
 * ### Deploying a Model
 * **Example:** gpt-4.1-mini, global standard
 * ```typescript
 * const account = yield* Azure.CognitiveServices.Account("OpenAI");
 * const chat = yield* Azure.CognitiveServices.Deployment("Chat", {
 *   account: account.accountName,
 *   name: "chat",
 *   model: { format: "OpenAI", name: "gpt-4.1-mini", version: "2025-04-14" },
 *   sku: { name: "GlobalStandard", capacity: 10 },
 * });
 * // chat.deploymentName === "chat"
 * ```
 *
 * **Example:** Two deployments on one account
 * ```typescript
 * const chat = yield* Azure.CognitiveServices.Deployment("Chat", {
 *   account: account.accountName,
 *   name: "chat",
 *   model: { format: "OpenAI", name: "gpt-4.1-mini", version: "2025-04-14" },
 *   sku: { name: "GlobalStandard", capacity: 10 },
 * });
 * // Created after Chat, so the two never run at the same time.
 * const embeddings = yield* Azure.CognitiveServices.Deployment("Embeddings", {
 *   account: account.accountName,
 *   name: "embeddings",
 *   model: { format: "OpenAI", name: "text-embedding-3-small", version: "1" },
 *   sku: { name: "GlobalStandard", capacity: 10 },
 * });
 * ```
 *
 * ### Capacity and Upgrades
 * **Example:** Raise capacity and pin the model version
 * ```typescript
 * const chat = yield* Azure.CognitiveServices.Deployment("Chat", {
 *   account: account.accountName,
 *   name: "chat",
 *   model: { format: "OpenAI", name: "gpt-4.1-mini", version: "2025-04-14" },
 *   sku: { name: "GlobalStandard", capacity: 50 },
 *   versionUpgradeOption: "NoAutoUpgrade",
 * });
 * ```
 *
 * **Example:** Keep data in one geography
 * ```typescript
 * const chat = yield* Azure.CognitiveServices.Deployment("Chat", {
 *   account: account.accountName,
 *   name: "chat",
 *   model: { format: "OpenAI", name: "gpt-4.1-mini", version: "2025-04-14" },
 *   sku: { name: "DataZoneStandard", capacity: 10 },
 * });
 * ```
 *
 * ### Content Filtering
 * **Example:** Apply a custom content filter
 * ```typescript
 * const policy = yield* Azure.CognitiveServices.RaiPolicy("Strict", {
 *   account: account.accountName,
 *   mode: "Blocking",
 *   contentFilters: [
 *     { name: "Hate", enabled: true, blocking: true, severityThreshold: "Low", source: "Prompt" },
 *   ],
 * });
 * const chat = yield* Azure.CognitiveServices.Deployment("Chat", {
 *   account: account.accountName,
 *   name: "chat",
 *   model: { format: "OpenAI", name: "gpt-4.1-mini", version: "2025-04-14" },
 *   raiPolicyName: policy.raiPolicyName,
 * });
 * ```
 *
 * ### Binding to a runtime
 * Bind the account, not the deployment, and pass the deployment's name as
 * `deploymentId`. The binding assigns a custom role with one data action on
 * the account to the host's identity (see `Azure.CognitiveServices.Account`).
 *
 * **Example:** Chat with the deployment from an Azure Function
 * ```typescript
 * // init
 * const chat = yield* Azure.CognitiveServices.OpenAICreateChatCompletion(account);
 *
 * // runtime
 * const reply = yield* chat({
 *   deploymentId: "chat",
 *   messages: [{ role: "user", content: "Say hello" }],
 * });
 * // …provided with Effect.provide(Azure.CognitiveServices.OpenAICreateChatCompletionHttp)
 * ```
 *
 * @resource
 */
export const Deployment = GroupedResource<Deployment>("Azure.CognitiveServices.Deployment");

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
        (news.name !== undefined && !sameArm(news.name, output.deploymentName)) ||
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
      const name = output?.deploymentName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getDeployment(subscriptionId, resourceGroup, account, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const name = news.name ?? output?.deploymentName ?? (yield* createChildName(id));
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
        (news.model.version !== undefined && props?.model?.version !== news.model.version) ||
        (news.raiPolicyName !== undefined && props?.raiPolicyName !== news.raiPolicyName) ||
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
            sku: skuChanged ? { name: sku.name, capacity: sku.capacity } : undefined,
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
        getDeployment(subscriptionId, output.resourceGroup, output.account, output.deploymentName),
        ACCOUNT_BUDGET,
      );
    }),
  });
