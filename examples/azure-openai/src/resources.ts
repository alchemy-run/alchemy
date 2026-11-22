import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/** Name of the chat deployment. Clients send it as the model ID. */
export const CHAT_DEPLOYMENT = "chat";
/** Name of the embeddings deployment. */
export const EMBEDDING_DEPLOYMENT = "embeddings";

/**
 * The Azure AI services account (S0, billed per token, $0 idle). Its custom
 * subdomain (the account name by default) is what lets the Function call
 * `{subdomain}.openai.azure.com` with its Entra ID token.
 */
export const OpenAI = Azure.CognitiveServices.Account("OpenAI");

/** `gpt-4.1-mini`, global standard: 10K tokens per minute, billed per token. */
export const Chat = Effect.gen(function* () {
  const account = yield* OpenAI;
  return yield* Azure.CognitiveServices.Deployment("Chat", {
    account: account.accountName,
    name: CHAT_DEPLOYMENT,
    model: { format: "OpenAI", name: "gpt-4.1-mini", version: "2025-04-14" },
    sku: { name: "GlobalStandard", capacity: 10 },
  });
});

/**
 * `text-embedding-3-small` (1536 dimensions). An account runs one
 * deployment operation at a time, so it waits for `Chat`.
 */
export const Embeddings = Effect.gen(function* () {
  const account = yield* OpenAI;
  yield* Chat;
  return yield* Azure.CognitiveServices.Deployment("Embeddings", {
    account: account.accountName,
    name: EMBEDDING_DEPLOYMENT,
    model: { format: "OpenAI", name: "text-embedding-3-small", version: "1" },
    sku: { name: "GlobalStandard", capacity: 10 },
  });
});
