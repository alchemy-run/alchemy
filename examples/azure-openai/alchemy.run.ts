import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Chat, Embeddings, OpenAI } from "./src/resources.ts";

export default Alchemy.Stack(
  "AzureOpenAIExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const account = yield* OpenAI;
    const chat = yield* Chat;
    const embeddings = yield* Embeddings;
    const api = yield* Api;

    return {
      url: api.url,
      resourceGroup: account.resourceGroup,
      accountName: account.accountName,
      accountId: account.accountId,
      location: account.location,
      chatDeployment: chat.deploymentName,
      embeddingDeployment: embeddings.deploymentName,
      functionAppName: api.functionAppName,
      principalId: api.principalId,
    };
  }),
);
