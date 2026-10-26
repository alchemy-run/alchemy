# Azure OpenAI on Azure Functions

A public API on Azure Functions that answers with Azure OpenAI. The stack
creates an Azure AI services account, deploys `gpt-4.1-mini` and
`text-embedding-3-small` on it, and binds both deployments to the Function.
There is no API key anywhere: the Function calls Azure OpenAI as its
system-assigned managed identity.

```sh
curl -X POST "$URL/chat" -H 'content-type: application/json' -d '{"prompt":"Write a haiku about rain"}'
# 200 {"text":"…","model":"gpt-4.1-mini-2025-04-14","finishReason":"stop","usage":{…}}

curl -X POST "$URL/embed" -H 'content-type: application/json' -d '{"input":["hello","world"]}'
# 200 {"model":"text-embedding-3-small","count":2,"dimensions":1536}
```

## Architecture

- [`OpenAI`](./src/resources.ts) — `Azure.CognitiveServices.Account`, kind
  `AIServices`, tier S0. Its custom subdomain (the account name by default)
  serves `{subdomain}.openai.azure.com`, which accepts Entra ID tokens.
- [`Chat`](./src/resources.ts) — `Azure.CognitiveServices.Deployment` of
  `gpt-4.1-mini`, `GlobalStandard`, 10K tokens per minute.
- [`Embeddings`](./src/resources.ts) — deployment of `text-embedding-3-small`,
  `GlobalStandard`, 10K tokens per minute.
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` with a public URL.

| Route         | What it does                                                          |
| ------------- | --------------------------------------------------------------------- |
| `GET /`       | health check                                                          |
| `POST /chat`  | `{ prompt, system? }` → `{ text, model, finishReason, usage }`        |
| `POST /embed` | `{ input: string[] }` → `{ model, count, dimensions }`                |

## Bindings

The Function binds the account in its init phase and calls the deployment by
name at runtime:

```ts
const chat = yield* Azure.CognitiveServices.OpenAICreateChatCompletion(account);

const reply = yield* chat({
  deploymentId: "chat",
  messages: [{ role: "user", content: prompt }],
});
```

Each binding assigns the Function's identity a custom role with exactly one
data action, on the account only. The built-in **Cognitive Services OpenAI
User** role is broader: it reads every Azure OpenAI object and runs every
deployment kind.

| Binding                                                                         | Data action, on the account                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Azure.CognitiveServices.OpenAICreateChatCompletion` + `OpenAICreateChatCompletionHttp` | `Microsoft.CognitiveServices/accounts/OpenAI/deployments/chat/completions/action` |
| `Azure.CognitiveServices.OpenAICreateEmbedding` + `OpenAICreateEmbeddingHttp`   | `Microsoft.CognitiveServices/accounts/OpenAI/deployments/embeddings/action` |

Role assignments can take a few minutes to take effect after the first
deploy. Until then Azure OpenAI answers `401` and the API answers `503` with
the Azure error. A rejected prompt answers `400`, and a throttled one `429`.

## Cost

The S0 account costs nothing while idle. `GlobalStandard` deployments are
billed per token, and the Flex Consumption app per execution. One test run
spends a few hundred tokens, well under $0.01, so the test is not gated.

Deployments use the subscription's model quota (tokens per minute) in the
account's region. Azure free trial subscriptions have no Azure OpenAI quota.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-openai
pnpm deploy --profile <name>
```

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack and reads both deployments through ARM. It checks
that the Function's identity holds exactly the two data actions on the
account. It asks `/chat` to reply `pong`, embeds two inputs through `/embed`,
and checks that a request without a prompt answers `400`. Then it destroys
the stack and checks that the account is deleted and purged and the function
app is gone.

## Destroy

```sh
pnpm destroy --profile <name>
```

Deleting an account only soft-deletes it for 48 hours. Alchemy purges it, so
the name and subdomain are free again right away.
