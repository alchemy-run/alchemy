import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Account } from "./Account.ts";

/**
 * Shared scaffolding for the Azure AI services account data-plane bindings
 * (Language, Question Answering, Content Safety): resolves the distilled
 * operation once when the layer is built, injects the bound account's
 * endpoint, and assigns the binding's custom role on that account at deploy
 * time.
 *
 * NOT exported from `index.ts`.
 */

const ACCOUNTS = "Microsoft.CognitiveServices/accounts";

/** Azure AI Language data actions (Azure RBAC). */
export const LanguageDataAction = {
  analyzeText: `${ACCOUNTS}/Language/analyze-text/action`,
  submitAnalyzeTextJob: `${ACCOUNTS}/Language/analyze-text/jobs/action`,
  readAnalyzeTextJob: `${ACCOUNTS}/Language/analyze-text/jobs/read`,
  cancelAnalyzeTextJob: `${ACCOUNTS}/Language/analyze-text/jobscancel/action`,
  analyzeConversations: `${ACCOUNTS}/Language/analyze-conversations/action`,
  submitAnalyzeConversationsJob: `${ACCOUNTS}/Language/analyze-conversations/jobs/action`,
  readAnalyzeConversationsJob: `${ACCOUNTS}/Language/analyze-conversations/jobs/read`,
  cancelAnalyzeConversationsJob: `${ACCOUNTS}/Language/analyze-conversations/jobscancel/action`,
  submitAnalyzeDocumentsJob: `${ACCOUNTS}/Language/analyze-documents/jobs/action`,
  readAnalyzeDocumentsJob: `${ACCOUNTS}/Language/analyze-documents/jobs/read`,
  cancelAnalyzeDocumentsJob: `${ACCOUNTS}/Language/analyze-documents/jobscancel/action`,
  queryKnowledgeBases: `${ACCOUNTS}/Language/query-knowledgebases/action`,
  queryText: `${ACCOUNTS}/Language/query-text/action`,
} as const;

/** Azure AI Content Safety data actions (Azure RBAC). */
export const ContentSafetyDataAction = {
  analyzeText: `${ACCOUNTS}/ContentSafety/text:analyze/action`,
  analyzeImage: `${ACCOUNTS}/ContentSafety/image:analyze/action`,
  detectProtectedMaterial: `${ACCOUNTS}/ContentSafety/text:detectprotectedmaterial/action`,
  shieldPrompt: `${ACCOUNTS}/ContentSafety/text:shieldprompt/action`,
  readBlocklists: `${ACCOUNTS}/ContentSafety/text/blocklists/read`,
  readBlocklistItems: `${ACCOUNTS}/ContentSafety/text/blocklists/blockitems/read`,
  writeBlocklists: `${ACCOUNTS}/ContentSafety/text/blocklists/write`,
  deleteBlocklists: `${ACCOUNTS}/ContentSafety/text/blocklists/delete`,
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound account) with
 * exactly `dataActions`. The smallest built-in role, **Cognitive Services
 * User**, grants every `Microsoft.CognitiveServices/*` data action (and
 * reading the account's keys), so every binding uses a custom role.
 */
export interface AccountDataGrant {
  readonly role: string;
  readonly dataActions: readonly string[];
}

const L = LanguageDataAction;
const C = ContentSafetyDataAction;

/** Custom role per Language binding; the logical ID is `AzureCognitiveServices<role>Role`. */
export const LanguageRole = {
  AnalyzeText: { role: "LanguageAnalyzeText", dataActions: [L.analyzeText] },
  SubmitAnalyzeTextJob: {
    role: "LanguageSubmitAnalyzeTextJob",
    dataActions: [L.submitAnalyzeTextJob],
  },
  ReadAnalyzeTextJob: { role: "LanguageReadAnalyzeTextJob", dataActions: [L.readAnalyzeTextJob] },
  CancelAnalyzeTextJob: {
    role: "LanguageCancelAnalyzeTextJob",
    dataActions: [L.cancelAnalyzeTextJob],
  },
  AnalyzeConversations: {
    role: "LanguageAnalyzeConversations",
    dataActions: [L.analyzeConversations],
  },
  SubmitAnalyzeConversationsJob: {
    role: "LanguageSubmitAnalyzeConversationsJob",
    dataActions: [L.submitAnalyzeConversationsJob],
  },
  ReadAnalyzeConversationsJob: {
    role: "LanguageReadAnalyzeConversationsJob",
    dataActions: [L.readAnalyzeConversationsJob],
  },
  CancelAnalyzeConversationsJob: {
    role: "LanguageCancelAnalyzeConversationsJob",
    dataActions: [L.cancelAnalyzeConversationsJob],
  },
  SubmitAnalyzeDocumentsJob: {
    role: "LanguageSubmitAnalyzeDocumentsJob",
    dataActions: [L.submitAnalyzeDocumentsJob],
  },
  ReadAnalyzeDocumentsJob: {
    role: "LanguageReadAnalyzeDocumentsJob",
    dataActions: [L.readAnalyzeDocumentsJob],
  },
  CancelAnalyzeDocumentsJob: {
    role: "LanguageCancelAnalyzeDocumentsJob",
    dataActions: [L.cancelAnalyzeDocumentsJob],
  },
  QueryKnowledgeBases: {
    role: "LanguageQueryKnowledgeBases",
    dataActions: [L.queryKnowledgeBases],
  },
  QueryText: { role: "LanguageQueryText", dataActions: [L.queryText] },
} as const satisfies Record<string, AccountDataGrant>;

/** Custom role per Content Safety binding; the logical ID is `AzureCognitiveServices<role>Role`. */
export const ContentSafetyRole = {
  AnalyzeText: { role: "ContentSafetyAnalyzeText", dataActions: [C.analyzeText] },
  AnalyzeImage: { role: "ContentSafetyAnalyzeImage", dataActions: [C.analyzeImage] },
  DetectProtectedMaterial: {
    role: "ContentSafetyDetectProtectedMaterial",
    dataActions: [C.detectProtectedMaterial],
  },
  ShieldPrompt: { role: "ContentSafetyShieldPrompt", dataActions: [C.shieldPrompt] },
  ReadBlocklists: { role: "ContentSafetyReadBlocklists", dataActions: [C.readBlocklists] },
  ReadBlocklistItems: {
    role: "ContentSafetyReadBlocklistItems",
    dataActions: [C.readBlocklistItems],
  },
  WriteBlocklists: { role: "ContentSafetyWriteBlocklists", dataActions: [C.writeBlocklists] },
  DeleteBlocklists: { role: "ContentSafetyDeleteBlocklists", dataActions: [C.deleteBlocklists] },
} as const satisfies Record<string, AccountDataGrant>;

/** Assign `grant` on the account to the host, creating its custom role. */
const GrantOnAccount = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, account: Account, grant: AccountDataGrant) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureCognitiveServices${grant.role}Role`, {
        description: `Alchemy Azure AI services binding: ${grant.dataActions.join(", ")}`,
        permissions: [{ dataActions: [...grant.dataActions] }],
      });
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [
        { roleDefinitionId: role.roleDefinitionId, scope: account.accountId },
      ];
      yield* bind`${tag}(${account})`({ roleAssignments });
    }
  });
});

/**
 * `https://{subdomain}.cognitiveservices.azure.com` of the account, without
 * the trailing slash ARM reports (the operations append `/language` or
 * `/contentsafety`), resolved per call at runtime.
 */
const endpointOf = (account: Account) =>
  account.endpoint.pipe(Output.map((endpoint) => (endpoint ?? "").replace(/\/+$/, "")));

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/**
 * Build the impl Effect for an account data-plane operation whose request
 * carries `endpoint`: the runtime callable injects the bound
 * {@link Account}'s endpoint, and the deploy-time half assigns `grant` on
 * the account.
 */
export const makeAccountDataHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CognitiveServices.AnalyzeText`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Custom role assigned on the account. */
  grant: AccountDataGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnAccount;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: Account) {
      yield* grant(options.tag, account, options.grant);
      const endpoint = yield* endpointOf(account);
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const url = yield* endpoint;
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: url } as I);
      });
    });
  });
