# STACKIT AI Model Serving

A chat endpoint on a `Stackit.Functions.Function` that answers with a shared model on AI Model Serving.

```sh
curl -X POST "$URL/chat" -d '{"prompt":"Say hello."}'
# {"text":"Hello!","usage":{…}}
```

## Architecture

- [`src/resources.ts`](./src/resources.ts): a `Stackit.ModelServing.Token`, and the model's name. `Stackit.ModelServing.ListModels` lists the names in a region.
- [`src/Chat.ts`](./src/Chat.ts): the function.
- [`src/registry.ts`](./src/registry.ts): the registry project the image goes to.

## Bindings

| Host | Binding                                                                | Access                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat | `Stackit.ModelServing.ChatCompletion(Inference)` + `ChatCompletionHttp` | The token itself, which reaches every shared model in its region. No role and no service account. Its value reaches the function as a plain revision variable. |

For Effect AI programs, use `Stackit.ModelServing.LanguageModel` instead.

Nothing here checks who calls the URL, and every prompt spends money. Destroy the stack when you're done, or add a check to the handler.

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).
- Docker running on your machine.
- A registry login: `HARBOR_USERNAME` and `HARBOR_CLI_SECRET`, your Harbor user and CLI secret from your user profile in the registry UI.
- Access to STACKIT Functions, an alpha API in `eu01` only.

## Cost

There's no hourly fee for the token or the model. Inference bills per million tokens: on a standard chat model such as `openai/gpt-oss-20b`, EUR 0.15 input and EUR 0.25 output (price list v1.0.44). A test run sends one short prompt, well under EUR 0.01. STACKIT's price list has no Functions SKU; the product page says you pay for what runs. Container Registry is free during its beta.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-ai
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, checks the `400`, sends one prompt, reads the token through the API, then destroys the stack and checks that the token is gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- `openai/gpt-oss-20b` is still on the list, with `ListModels`.
- A token is readable right after it is created. Alchemy waits up to 10 minutes for it.
- The function answers on `8080`, the port Alchemy assumes, and its URL takes requests with no STACKIT token.

## Destroy

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name> --stage test_$USER
```
