import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  stackAndStage,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  ACCOUNT_BUDGET,
  type CognitiveServicesIdentity,
  createAccountName,
  identityDiffers,
  MANAGED_NETWORK_ACCOUNT_BUDGET,
  sameArm,
  sameValue,
  toIdentityInput,
  whileAccountBusy,
} from "./Common.ts";

export type AccountKind =
  | "AIServices"
  | "OpenAI"
  | "CognitiveServices"
  | "TextAnalytics"
  | "ComputerVision"
  | "SpeechServices"
  | "FormRecognizer"
  | "ContentSafety"
  | "Face"
  | "TextTranslation"
  | (string & {});

export interface AccountNetworkAcls {
  /** Action when no IP or virtual network rule matches. */
  defaultAction: "Allow" | "Deny";
  /**
   * Let trusted Azure services bypass the rules.
   * @default Azure's default (`AzureServices`)
   */
  bypass?: "None" | "AzureServices";
  /**
   * Allowed IPv4 addresses or CIDR ranges.
   * @default []
   */
  ipRules?: string[];
  /**
   * ARM resource IDs of allowed virtual network subnets.
   * @default []
   */
  virtualNetworkRules?: string[];
}

export interface AccountNetworkInjection {
  /** Scenario the injection applies to. */
  scenario: "agent" | "none";
  /**
   * ARM ID of a delegated subnet to inject into.
   * @default none
   */
  subnetArmId?: string;
  /**
   * Use a Microsoft-managed virtual network instead of your own subnet
   * (required by `CognitiveServices.ManagedNetwork`).
   * @default false
   */
  useMicrosoftManagedNetwork?: boolean;
}

export interface AccountProps {
  /**
   * Resource group the account is created in.
   *
   * :::caution
   * Changing it replaces the account and deletes its deployments and projects.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Account name: 2-64 letters, digits, and hyphens.
   *
   * :::caution
   * Changing it replaces the account and deletes its deployments and projects.
   * :::
   * @default a unique lowercase name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the account. Model availability differs by region.
   *
   * :::caution
   * Changing it replaces the account and deletes its deployments and projects.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Kind of service: `AIServices` for Azure AI Foundry and multi-service
   * access, `OpenAI`, `TextAnalytics` (Language), `ContentSafety`,
   * `TextTranslation`, `SpeechServices`, `FormRecognizer` (Document
   * Intelligence), …
   *
   * :::caution
   * Changing it replaces the account and deletes its deployments and projects.
   * :::
   * @default "AIServices"
   */
  kind?: AccountKind;
  /**
   * Pricing tier. `F0` (free) is limited to one account per kind per
   * subscription. Changing it updates the account in place.
   * @default "S0"
   */
  sku?: string;
  /**
   * Globally unique subdomain of the account endpoint
   * (`https://{customSubDomainName}.cognitiveservices.azure.com/`).
   * Microsoft Entra ID auth, network rules, and projects need it.
   *
   * :::caution
   * Azure cannot change it once set. Changing it replaces the account and
   * deletes its deployments and projects.
   * :::
   * @default the account name
   */
  customSubDomainName?: string;
  /**
   * Managed identity of the account. Foundry projects and customer-managed
   * keys need a system-assigned identity.
   * @default no identity
   */
  identity?: CognitiveServicesIdentity;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Network rules for the public endpoint.
   * @default no rules (every network may connect)
   */
  networkAcls?: AccountNetworkAcls;
  /**
   * Disable key-based (local) authentication so callers must use
   * Microsoft Entra ID.
   * @default false
   */
  disableLocalAuth?: boolean;
  /**
   * Allow the account to hold Azure AI Foundry projects. Required by
   * `CognitiveServices.Project`; it cannot be turned off while projects
   * exist.
   * @default false
   */
  allowProjectManagement?: boolean;
  /**
   * Project targeted by data-plane calls that do not name a project.
   * @default none
   */
  defaultProject?: string;
  /**
   * Restrict outbound calls of the account to `allowedFqdnList`.
   * @default false
   */
  restrictOutboundNetworkAccess?: boolean;
  /**
   * FQDNs the account may call when outbound access is restricted.
   * @default []
   */
  allowedFqdnList?: string[];
  /**
   * Network injection for Foundry agents: your own delegated subnet, or a
   * Microsoft-managed network (`useMicrosoftManagedNetwork: true`).
   * @default none
   */
  networkInjections?: AccountNetworkInjection[];
  /**
   * Enable dynamic throttling.
   * @default Azure's default (`false`)
   */
  dynamicThrottlingEnabled?: boolean;
  /**
   * Disable stored completions (Azure OpenAI).
   * @default Azure's default (`false`)
   */
  storedCompletionsDisabled?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "Azure.CognitiveServices.Account",
  AccountProps,
  {
    /** Name of the account. */
    accountName: string;
    /** ARM resource ID of the account; use it as a role-assignment scope. */
    accountId: string;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** Location of the account. */
    location: string;
    /** Kind of service. */
    kind: string;
    /** Pricing tier. */
    sku: string;
    /** Custom subdomain of the account endpoint. */
    customSubDomainName: string | undefined;
    /** Primary endpoint, e.g. `https://{subdomain}.cognitiveservices.azure.com/`. */
    endpoint: string | undefined;
    /** Endpoints by API name (e.g. `OpenAI Language Model Instance API`). */
    endpoints: Record<string, string>;
    /** Object ID of the account's system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure AI services account (`Microsoft.CognitiveServices/accounts`):
 * the root resource of Azure AI Foundry, Azure OpenAI, and the single Azure
 * AI services (Language, Vision, Speech, Content Safety, Translator,
 * Document Intelligence, …).
 *
 * Alchemy creates an `AIServices` account on the `S0` tier (billed per
 * call, $0 while idle) with a custom subdomain equal to its name. The
 * subdomain is what lets runtimes call the account with a Microsoft Entra
 * token, so bindings never handle keys: each binding assigns a custom role
 * with one data action on this account to the host's identity. Deploy
 * models into the account with `Azure.CognitiveServices.Deployment`.
 *
 * :::caution[Changing `name`, `location`, `kind`, `customSubDomainName`, or `resourceGroup` replaces the account]
 * Alchemy creates a new account and deletes the old one with its model
 * deployments, projects, and data (agents, files, fine-tuned models).
 * :::
 *
 * :::caution[Deleted accounts are soft-deleted]
 * Azure keeps a deleted account, its name, and its subdomain for 48 hours.
 * Alchemy purges the deleted account on destroy, so you can reuse the name
 * at once.
 * :::
 *
 * See [Create an Azure AI services resource](https://learn.microsoft.com/azure/ai-services/multi-service-resource).
 *
 * ### Creating an Account
 * **Example:** Azure AI services (Foundry) account
 * ```typescript
 * const ai = yield* Azure.CognitiveServices.Account("Ai");
 * // ai.endpoint → "https://<name>.cognitiveservices.azure.com/"
 * // ai.endpoints["OpenAI Language Model Instance API"] → "https://<name>.openai.azure.com/"
 * ```
 *
 * **Example:** Azure OpenAI account in a chosen region
 * ```typescript
 * const openai = yield* Azure.CognitiveServices.Account("OpenAI", {
 *   kind: "OpenAI",
 *   location: "eastus2",
 * });
 * ```
 *
 * **Example:** Single-service accounts
 * ```typescript
 * const language = yield* Azure.CognitiveServices.Account("Language", { kind: "TextAnalytics" });
 * const safety = yield* Azure.CognitiveServices.Account("Safety", { kind: "ContentSafety" });
 * const translator = yield* Azure.CognitiveServices.Account("Translator", {
 *   kind: "TextTranslation",
 * });
 * ```
 *
 * **Example:** Free tier
 * ```typescript
 * // One F0 account per kind per subscription.
 * const language = yield* Azure.CognitiveServices.Account("Language", {
 *   kind: "TextAnalytics",
 *   sku: "F0",
 * });
 * ```
 *
 * ### Deploying Models
 * **Example:** A chat model and an embeddings model
 * ```typescript
 * const account = yield* Azure.CognitiveServices.Account("OpenAI");
 * const chat = yield* Azure.CognitiveServices.Deployment("Chat", {
 *   account: account.accountName,
 *   name: "chat",
 *   model: { format: "OpenAI", name: "gpt-4.1-mini", version: "2025-04-14" },
 *   sku: { name: "GlobalStandard", capacity: 10 },
 * });
 * ```
 *
 * ### Authentication
 * **Example:** Entra ID only (no keys)
 * ```typescript
 * const account = yield* Azure.CognitiveServices.Account("Ai", {
 *   disableLocalAuth: true,
 * });
 * ```
 *
 * ### Azure AI Foundry Projects
 * **Example:** Account that holds Foundry projects
 * ```typescript
 * const foundry = yield* Azure.CognitiveServices.Account("Foundry", {
 *   kind: "AIServices",
 *   allowProjectManagement: true,
 *   identity: { type: "SystemAssigned" },
 * });
 * const project = yield* Azure.CognitiveServices.Project("Agents", {
 *   account: foundry.accountName,
 *   displayName: "Agents",
 * });
 * ```
 *
 * ### Network Access
 * **Example:** Allow only one IP range
 * ```typescript
 * const account = yield* Azure.CognitiveServices.Account("Ai", {
 *   networkAcls: { defaultAction: "Deny", ipRules: ["203.0.113.0/24"] },
 * });
 * ```
 *
 * **Example:** Private-only account behind a private endpoint
 * ```typescript
 * const account = yield* Azure.CognitiveServices.Account("Ai", {
 *   publicNetworkAccess: "Disabled",
 * });
 * yield* Azure.Network.PrivateEndpoint("AiEndpoint", {
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: account.accountId, groupIds: ["account"] },
 *   ],
 * });
 * ```
 *
 * **Example:** Restrict outbound calls
 * ```typescript
 * const account = yield* Azure.CognitiveServices.Account("Ai", {
 *   restrictOutboundNetworkAccess: true,
 *   allowedFqdnList: ["docs.blob.core.windows.net"],
 * });
 * ```
 *
 * ### Binding to a runtime
 * Bind the account inside the host and provide the matching `*Http`
 * layer. Each binding assigns a custom role with exactly one data action
 * (for example `OpenAI/deployments/chat/completions/action`) on this
 * account only, to the host's managed identity (an Azure Function, Web App,
 * Container App, container group, or VM) or, on any other host, to an
 * Entra service principal. Calls answer `401` for a few minutes after the
 * first deploy, until the role assignments propagate.
 *
 * **Example:** Chat and embeddings from an Azure Function
 * ```typescript
 * // src/Api.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Chat, Embeddings, OpenAI } from "./resources.ts";
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* OpenAI;
 *     yield* Chat;
 *     yield* Embeddings;
 *     const chat = yield* Azure.CognitiveServices.OpenAICreateChatCompletion(account);
 *     const embed = yield* Azure.CognitiveServices.OpenAICreateEmbedding(account);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const reply = yield* chat({
 *           deploymentId: "chat", // the deployment's name
 *           messages: [{ role: "user", content: "Say hello" }],
 *           max_tokens: 200,
 *         });
 *         const vectors = yield* embed({ deploymentId: "embeddings", input: ["hello"] });
 *         return yield* HttpServerResponse.json({
 *           text: reply.object === "chat.completion" ? reply.choices[0]?.message.content : "",
 *           dimensions: vectors.data[0]?.embedding.length,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide([
 *       Azure.CognitiveServices.OpenAICreateChatCompletionHttp,
 *       Azure.CognitiveServices.OpenAICreateEmbeddingHttp,
 *     ]),
 *   ),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Screen user text with Content Safety
 * ```typescript
 * // init: an account of kind ContentSafety or AIServices
 * const analyzeTextSafety = yield* Azure.CognitiveServices.AnalyzeTextSafety(safety);
 *
 * // runtime
 * const { categoriesAnalysis } = yield* analyzeTextSafety({ text: userMessage });
 * const flagged = categoriesAnalysis.some((c) => (c.severity ?? 0) >= 4);
 * // …provided with Effect.provide(Azure.CognitiveServices.AnalyzeTextSafetyHttp)
 * ```
 *
 * **Example:** Translate text
 * ```typescript
 * // init: an account of kind TextTranslation or AIServices
 * const translateText = yield* Azure.CognitiveServices.TranslateText(translator);
 *
 * // runtime
 * const [result] = yield* translateText({ to: ["de", "fr"], body: [{ text: "Hello" }] });
 * // …provided with Effect.provide(Azure.CognitiveServices.TranslateTextHttp)
 * ```
 *
 * **Example:** Sentiment analysis
 * ```typescript
 * // init: an account of kind TextAnalytics or AIServices
 * const analyzeText = yield* Azure.CognitiveServices.AnalyzeText(language);
 *
 * // runtime
 * const sentiment = yield* analyzeText({
 *   kind: "SentimentAnalysis",
 *   analysisInput: { documents: [{ id: "1", text: "I love this", language: "en" }] },
 * });
 * // …provided with Effect.provide(Azure.CognitiveServices.AnalyzeTextHttp)
 * ```
 *
 * **Example:** Read a document with Document Intelligence
 * ```typescript
 * // init
 * const analyzeDocument = yield* Azure.CognitiveServices.AnalyzeDocument(account);
 *
 * // runtime: Azure analyzes in the background; poll the operation location
 * const { operationLocation } = yield* analyzeDocument({
 *   modelId: "prebuilt-read",
 *   urlSource: "https://example.com/receipt.png",
 * });
 * // …provided with Effect.provide(Azure.CognitiveServices.AnalyzeDocumentHttp)
 * ```
 *
 * **Example:** Run a Foundry agent
 * ```typescript
 * // init: agent bindings take an Azure.CognitiveServices.Project
 * const createAgent = yield* Azure.CognitiveServices.CreateAgent(project);
 * const createAgentThreadAndRun = yield* Azure.CognitiveServices.CreateAgentThreadAndRun(project);
 *
 * // runtime
 * const agent = yield* createAgent({ model: "chat", name: "support", instructions: "Answer in one sentence." });
 * const run = yield* createAgentThreadAndRun({
 *   assistant_id: agent.id,
 *   thread: { messages: [{ role: "user", content: "Hello" }] },
 * });
 * // …provided with Effect.provide([Azure.CognitiveServices.CreateAgentHttp, Azure.CognitiveServices.CreateAgentThreadAndRunHttp])
 * ```
 *
 * ### Deleting an Account
 * Destroying the account deletes its deployments and projects, then purges
 * the soft-deleted account so the name is free again.
 *
 * **Example:** Keep the account when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const account = yield* Azure.CognitiveServices.Account("OpenAI").pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const Account = GroupedResource<Account>("Azure.CognitiveServices.Account");

type ObservedAccount = cognitiveservices.GetAccountResponse;

export const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetAccount({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

/** Whether an observed account is injected into a Microsoft-managed network. */
export const usesMicrosoftManagedNetwork = (
  account: cognitiveservices.GetAccountResponse | undefined,
) =>
  account?.properties?.networkInjections?.some(
    (injection) => injection.useMicrosoftManagedNetwork === true,
  ) === true;

export const getDeletedAccount = (
  subscriptionId: string,
  location: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetDeletedAccount({
      subscriptionId,
      location,
      resourceGroupName,
      accountName,
    }),
  );

/**
 * Whether the account carries this stack/stage's ownership tags. Used as the
 * ownership signal for children that cannot be tagged (account singletons,
 * capability hosts).
 */
export const isAccountOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) {
  const account = yield* getAccount(subscriptionId, resourceGroupName, accountName);
  if (account === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  return account.tags?.["alchemy::stack"] === stack && account.tags?.["alchemy::stage"] === stage;
});

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: ObservedAccount,
): Account["Attributes"] => ({
  accountName: name,
  accountId: account.id ?? "",
  resourceGroup,
  location: account.location ?? "",
  kind: account.kind ?? "",
  sku: account.sku?.name ?? "",
  customSubDomainName: account.properties?.customSubDomainName,
  endpoint: account.properties?.endpoint,
  endpoints: Object.fromEntries(
    Object.entries(account.properties?.endpoints ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  principalId: account.identity?.principalId,
  tags: userTags(account.tags),
});

const toNetworkAcls = (
  acls: AccountNetworkAcls | undefined,
): cognitiveservices.NetworkRuleSet | undefined =>
  acls === undefined
    ? undefined
    : {
        defaultAction: acls.defaultAction,
        bypass: acls.bypass,
        ipRules: (acls.ipRules ?? []).map((value) => ({ value })),
        virtualNetworkRules: (acls.virtualNetworkRules ?? []).map((id) => ({
          id,
        })),
      };

const networkAclsDiffer = (
  observed: cognitiveservices.NetworkRuleSet | undefined,
  desired: AccountNetworkAcls | undefined,
) => {
  if (desired === undefined) return false;
  const norm = (acls: cognitiveservices.NetworkRuleSet | undefined) => ({
    defaultAction: acls?.defaultAction ?? "Allow",
    bypass: desired.bypass === undefined ? undefined : acls?.bypass,
    ipRules: (acls?.ipRules ?? []).map((rule) => rule.value).sort(),
    virtualNetworkRules: (acls?.virtualNetworkRules ?? [])
      .map((rule) => rule.id.toLowerCase())
      .sort(),
  });
  return !sameValue(norm(observed), norm(toNetworkAcls(desired)));
};

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: [
      "accountName",
      "accountId",
      "resourceGroup",
      "location",
      "kind",
      "customSubDomainName",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(cognitiveservices.ListAccounts, { subscriptionId });
      return (page.value ?? []).flatMap((account) => {
        const group = resourceGroupOf(account.id);
        return hasAnyAlchemyTag(account.tags) && group !== undefined && account.name !== undefined
          ? [toAttrs(group, account.name, account)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameArm(news.name, output.accountName)) ||
        (news.location !== undefined && !sameArm(news.location, output.location)) ||
        !sameArm(news.kind ?? "AIServices", output.kind) ||
        (news.customSubDomainName !== undefined &&
          output.customSubDomainName !== undefined &&
          !sameArm(news.customSubDomainName, output.customSubDomainName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.accountName ?? olds?.name ?? (yield* createAccountName(id));
      const observed = yield* getAccount(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.accountName ?? (yield* createAccountName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "S0";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const label = `cognitive services account ${name}`;
      const get = getAccount(subscriptionId, resourceGroup, name);
      const desired = {
        publicNetworkAccess: news.publicNetworkAccess,
        disableLocalAuth: news.disableLocalAuth,
        allowProjectManagement: news.allowProjectManagement,
        defaultProject: news.defaultProject,
        restrictOutboundNetworkAccess: news.restrictOutboundNetworkAccess,
        dynamicThrottlingEnabled: news.dynamicThrottlingEnabled,
        storedCompletionsDisabled: news.storedCompletionsDisabled,
      };

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running PUT.
      if (observed === undefined) {
        yield* cognitiveservices.CreateAccount({
          ...where,
          location,
          kind: news.kind ?? "AIServices",
          sku: { name: sku },
          identity: toIdentityInput(news.identity),
          tags,
          properties: {
            ...desired,
            customSubDomainName: news.customSubDomainName ?? name,
            networkAcls: toNetworkAcls(news.networkAcls),
            allowedFqdnList: news.allowedFqdnList,
            networkInjections: news.networkInjections,
          },
        });
      }
      const budget = news.networkInjections?.some(
        (injection) => injection.useMicrosoftManagedNetwork === true,
      )
        ? MANAGED_NETWORK_ACCOUNT_BUDGET
        : ACCOUNT_BUDGET;
      observed = yield* waitForProvisioned(
        label,
        get,
        (account) => account.properties?.provisioningState,
        budget,
      );

      // Sync each mutable aspect against the observed account; PATCH only
      // the deltas.
      const props = observed.properties ?? {};
      const changed: cognitiveservices.AccountPropertiesInput = {};
      for (const key of Object.keys(desired) as (keyof typeof desired)[]) {
        const value = desired[key];
        if (value !== undefined && props[key] !== value) {
          Object.assign(changed, { [key]: value });
        }
      }
      if (props.customSubDomainName === undefined || props.customSubDomainName === "") {
        changed.customSubDomainName = news.customSubDomainName ?? name;
      }
      if (networkAclsDiffer(props.networkAcls, news.networkAcls)) {
        changed.networkAcls = toNetworkAcls(news.networkAcls);
      }
      if (
        news.allowedFqdnList !== undefined &&
        !sameValue([...(props.allowedFqdnList ?? [])].sort(), [...news.allowedFqdnList].sort())
      ) {
        changed.allowedFqdnList = news.allowedFqdnList;
      }
      if (
        news.networkInjections !== undefined &&
        !sameValue(
          (props.networkInjections ?? []).map((n) => ({
            ...n,
            subnetArmId: n.subnetArmId?.toLowerCase(),
          })),
          news.networkInjections.map((n) => ({
            ...n,
            subnetArmId: n.subnetArmId?.toLowerCase(),
          })),
        )
      ) {
        changed.networkInjections = news.networkInjections;
      }
      const skuChanged = !sameArm(observed.sku?.name, sku);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged || identityChanged) {
        yield* cognitiveservices
          .UpdateAccount({
            ...where,
            sku: skuChanged ? { name: sku } : undefined,
            tags: tagsChanged ? tags : undefined,
            identity: identityChanged ? toIdentityInput(news.identity) : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForProvisioned(
          label,
          get,
          (account) => account.properties?.provisioningState,
          budget,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accountName: output.accountName,
      };
      const label = `cognitive services account ${output.accountName}`;
      const get = getAccount(subscriptionId, output.resourceGroup, output.accountName);
      const current = yield* get;
      const budget = usesMicrosoftManagedNetwork(current)
        ? MANAGED_NETWORK_ACCOUNT_BUDGET
        : ACCOUNT_BUDGET;
      // An account still creating or updating rejects the delete with a
      // conflict; let it settle (a `Failed` account is deletable, and a
      // `Deleting` one only needs observing).
      if (current !== undefined) {
        yield* waitForProvisioned(
          label,
          get,
          (account) =>
            account.properties?.provisioningState === "Deleting"
              ? "Succeeded"
              : account.properties?.provisioningState,
          budget,
        ).pipe(Effect.ignore);
      }
      // An account already `Deleting` (e.g. an earlier attempt whose request
      // hit the gateway timeout) rejects another DELETE with a conflict that
      // never clears; that delete is ours and only needs observing.
      const alreadyDeleting = get.pipe(
        Effect.map(
          (account) =>
            account === undefined || account.properties?.provisioningState === "Deleting",
        ),
      );
      yield* ignoreNotFound(
        cognitiveservices.DeleteAccount(where).pipe(
          // Tearing down a managed network outlives the ARM gateway; the
          // delete continues server-side and waitUntilGone observes it.
          Effect.catchTag("GatewayTimeout", () => Effect.void),
          Effect.catchTag("CognitiveServicesRequestConflict", (error) =>
            Effect.flatMap(alreadyDeleting, (deleting) =>
              deleting ? Effect.void : Effect.fail(error),
            ),
          ),
          Effect.retry(whileAccountBusy),
        ),
      );
      yield* waitUntilGone(label, get, budget);
      // Deleting only soft-deletes the account; purge it so the name and
      // subdomain are released and nothing lingers.
      const deleted = { ...where, location: output.location };
      yield* ignoreNotFound(cognitiveservices.PurgeDeletedAccount(deleted));
      yield* waitUntilGone(
        `deleted ${label}`,
        getDeletedAccount(
          subscriptionId,
          output.location,
          output.resourceGroup,
          output.accountName,
        ),
        ACCOUNT_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
