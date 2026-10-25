import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Account } from "./Account.ts";

/**
 * Shared scaffolding for the Speech, Translator, and Vision data-plane
 * bindings on an `Azure.CognitiveServices.Account`: resolves the distilled
 * operation once when the layer is built, injects the account's endpoint,
 * and assigns the binding's custom role on the account at deploy time.
 *
 * NOT exported from `index.ts`.
 */

const action = (path: string) => `Microsoft.CognitiveServices/accounts/${path}`;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound account) with
 * exactly `dataActions`. The built-in **Cognitive Services User** grants
 * every data action of every AI service (`Microsoft.CognitiveServices/*`),
 * and **Cognitive Services Speech User** every Speech action, so each
 * binding gets its own narrower role.
 */
export interface CognitiveGrant {
  /** Logical ID suffix of the role: `AzureCognitive<role>Role`. */
  readonly role: string;
  readonly dataActions: readonly string[];
}

/** The custom role each binding assigns, by binding. */
export const CognitiveRole = {
  TranslateText: {
    role: "TranslateText",
    dataActions: [action("TextTranslation/translate/action")],
  },
  TransliterateText: {
    role: "TransliterateText",
    dataActions: [action("TextTranslation/transliterate/action")],
  },
  DetectTextLanguage: {
    role: "DetectTextLanguage",
    dataActions: [action("TextTranslation/detect/action")],
  },
  BreakSentences: {
    role: "BreakSentences",
    dataActions: [action("TextTranslation/breaksentence/action")],
  },
  LookupDictionary: {
    role: "LookupDictionary",
    dataActions: [action("TextTranslation/dictionary/lookup/action")],
  },
  LookupDictionaryExamples: {
    role: "LookupDictionaryExamples",
    dataActions: [action("TextTranslation/dictionary/examples/action")],
  },
  ListTranslatorLanguages: {
    role: "ListTranslatorLanguages",
    dataActions: [action("TextTranslation/languages/read")],
  },
  TranscribeAudio: {
    role: "TranscribeAudio",
    dataActions: [action("SpeechServices/speechrest/transcriptions/action")],
  },
  SubmitTranscription: {
    role: "SubmitTranscription",
    dataActions: [action("SpeechServices/speechrest/transcriptions/write")],
  },
  GetTranscription: {
    role: "GetTranscription",
    dataActions: [action("SpeechServices/speechrest/transcriptions/read")],
  },
  ListTranscriptionFiles: {
    role: "ListTranscriptionFiles",
    dataActions: [action("SpeechServices/speechrest/transcriptions/files/read")],
  },
  DeleteTranscription: {
    role: "DeleteTranscription",
    dataActions: [action("SpeechServices/speechrest/transcriptions/delete")],
  },
  VectorizeImage: {
    role: "VectorizeImage",
    dataActions: [action("ComputerVision/retrieval:vectorizeimage/action")],
  },
  VectorizeText: {
    role: "VectorizeText",
    dataActions: [action("ComputerVision/retrieval:vectorizetext/action")],
  },
} as const satisfies Record<string, CognitiveGrant>;

/** Assign `grant` on the account to the host, creating its custom role. */
const GrantOnAccount = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, account: Account, grant: CognitiveGrant) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureCognitive${grant.role}Role`, {
        description: `Alchemy AI services binding: ${grant.dataActions.join(", ")}`,
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
 * Where each data plane lives under the account's custom-subdomain
 * endpoint (`https://{subdomain}.cognitiveservices.azure.com`). Entra
 * tokens only work against the custom subdomain: a `TextTranslation`
 * account reports the global Translator endpoint as its `endpoint`, which
 * takes keys only.
 */
export const CognitivePath = {
  /** Translator Text v3.0. */
  translator: "/translator/text/v3.0",
  /** Image Analysis 4.0 and multimodal embeddings. */
  vision: "/computervision",
  /** Speech to text (the operations add `/speechtotext`). */
  speech: "",
} as const;

/** The account's custom-subdomain endpoint plus `path`. */
const endpointOf = (customSubDomainName: string | undefined, path: string) =>
  `https://${customSubDomainName ?? ""}.cognitiveservices.azure.com${path}`;

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/**
 * Build the impl Effect of a binding over a distilled AI services
 * operation whose request carries `endpoint`: the runtime callable injects
 * the bound account's endpoint (plus `path`), and the deploy-time half
 * assigns `grant` on the account.
 */
export const makeCognitiveHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CognitiveServices.TranslateText`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Data-plane path under the account endpoint. */
  path: string;
  /** Role assigned on the account. */
  grant: CognitiveGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnAccount;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: Account) {
      yield* grant(options.tag, account, options.grant);
      // Bind the plain attribute: a runtime value is keyed by its
      // expression, so mapped values of different bindings would share a key.
      const subdomain = yield* account.customSubDomainName;
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (
        request: Omit<I, "endpoint">,
      ) {
        const customSubDomainName = yield* subdomain;
        const url = endpointOf(customSubDomainName, options.path);
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: url } as I);
      });
    });
  });
