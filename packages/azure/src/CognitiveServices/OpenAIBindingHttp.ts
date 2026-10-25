import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Account } from "./Account.ts";

/**
 * Shared scaffolding for the Azure OpenAI data-plane bindings
 * (`cognitiveservices-openai-inference` and
 * `cognitiveservices-openai-authoring`): resolves the distilled operation
 * once when the layer is built, injects the bound account's Azure OpenAI
 * endpoint, and assigns the binding's custom role on that account at deploy
 * time.
 *
 * NOT exported from `index.ts`.
 */

const OPENAI = "Microsoft.CognitiveServices/accounts/OpenAI";

/** Azure OpenAI data actions (Azure RBAC). */
export const OpenAIDataAction = {
  chatCompletions: `${OPENAI}/deployments/chat/completions/action`,
  completions: `${OPENAI}/deployments/completions/action`,
  embeddings: `${OPENAI}/deployments/embeddings/action`,
  audio: `${OPENAI}/deployments/audio/action`,
  imageGenerations: `${OPENAI}/images/generations/action`,
  readModels: `${OPENAI}/models/read`,
  readFiles: `${OPENAI}/files/read`,
  writeFiles: `${OPENAI}/files/write`,
  deleteFiles: `${OPENAI}/files/delete`,
  writeUploads: `${OPENAI}/uploads/write`,
  createBatches: `${OPENAI}/batches/action`,
  readBatches: `${OPENAI}/batches/read`,
  cancelBatches: `${OPENAI}/batches/cancel/action`,
  readFineTunes: `${OPENAI}/fine-tunes/read`,
  writeFineTunes: `${OPENAI}/fine-tunes/write`,
  deleteFineTunes: `${OPENAI}/fine-tunes/delete`,
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound account) with
 * exactly `dataActions`. The smallest built-in roles are broader:
 * **Cognitive Services OpenAI User** reads every `OpenAI/*` object and runs
 * every deployment kind plus assistants and responses, and **Cognitive
 * Services OpenAI Contributor** grants `OpenAI/*`.
 */
export interface OpenAIGrant {
  readonly role: string;
  readonly dataActions: readonly string[];
}

const A = OpenAIDataAction;

/** Custom role per binding kind; the logical ID is `AzureOpenAI<role>Role`. */
export const OpenAIRole = {
  ChatCompletion: { role: "ChatCompletion", dataActions: [A.chatCompletions] },
  Completion: { role: "Completion", dataActions: [A.completions] },
  Embedding: { role: "Embedding", dataActions: [A.embeddings] },
  Audio: { role: "Audio", dataActions: [A.audio] },
  ImageGeneration: { role: "ImageGeneration", dataActions: [A.imageGenerations] },
  ModelRead: { role: "ModelRead", dataActions: [A.readModels] },
  FileRead: { role: "FileRead", dataActions: [A.readFiles] },
  FileWrite: { role: "FileWrite", dataActions: [A.writeFiles] },
  FileDelete: { role: "FileDelete", dataActions: [A.deleteFiles] },
  UploadWrite: { role: "UploadWrite", dataActions: [A.writeUploads] },
  BatchCreate: { role: "BatchCreate", dataActions: [A.createBatches] },
  BatchRead: { role: "BatchRead", dataActions: [A.readBatches] },
  BatchCancel: { role: "BatchCancel", dataActions: [A.cancelBatches] },
  FineTuningRead: { role: "FineTuningRead", dataActions: [A.readFineTunes] },
  FineTuningWrite: { role: "FineTuningWrite", dataActions: [A.writeFineTunes] },
  FineTuningDelete: { role: "FineTuningDelete", dataActions: [A.deleteFineTunes] },
} as const satisfies Record<string, OpenAIGrant>;

/** Assign `grants` on the account to the host, creating the custom roles they name. */
const GrantOpenAIRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, account: Account, grants: readonly OpenAIGrant[]) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        const role = yield* AzureRoleDefinition(`AzureOpenAI${grant.role}Role`, {
          description: `Alchemy Azure OpenAI binding: ${grant.dataActions.join(", ")}`,
          permissions: [{ dataActions: [...grant.dataActions] }],
        });
        roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope: account.accountId });
      }
      yield* bind`${tag}(${account})`({ roleAssignments });
    }
  });
});

/**
 * The account's Azure OpenAI host, `{customSubDomainName}.openai.azure.com`,
 * resolved per call at runtime. Entra ID tokens only work on the custom
 * subdomain, which `Azure.CognitiveServices.Account` sets by default.
 */
const openAIHostOf = (account: Account) =>
  Output.interpolate`${account.customSubDomainName}.openai.azure.com`;

/**
 * Build the impl Effect for an Azure OpenAI operation whose request carries
 * the account `endpoint`: the runtime callable injects the bound
 * {@link Account}'s endpoint, and the deploy-time half assigns `grants` on
 * the account.
 *
 * `endpoint` is the bare host for the inference module
 * (`https://{endpoint}/openai`) and the full URL for the authoring module
 * (`{endpoint}/openai`).
 */
export const makeOpenAIHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CognitiveServices.OpenAICreateChatCompletion`. */
  tag: string;
  /** The distilled operation; the account endpoint is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** How the operation takes the endpoint. */
  endpoint: "host" | "url";
  /** Roles assigned on the account. */
  grants: readonly OpenAIGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOpenAIRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: Account) {
      yield* grant(options.tag, account, options.grants);
      const host = yield* openAIHostOf(account);
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const value = yield* host;
        const endpoint = options.endpoint === "url" ? `https://${value}` : value;
        return yield* op({ ...request, endpoint } as I);
      });
    });
  });
