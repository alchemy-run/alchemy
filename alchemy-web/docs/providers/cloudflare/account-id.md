# AccountId

The AccountId resource retrieves your [Cloudflare Account ID](https://developers.cloudflare.com/fundamentals/get-started/basic-tasks/find-account-and-zone-ids/) for use with other Cloudflare resources.

# Minimal Example

Gets the account ID using environment variables or API token.

```ts
import { AccountId } from "alchemy/cloudflare";

const accountId = await AccountId("my-account", {});
```

# With Explicit API Key

Specify API key and email directly instead of using environment variables.

```ts 
import { AccountId } from "alchemy/cloudflare";

const accountId = await AccountId("my-account", {
  apiKey: alchemy.secret(process.env.CF_API_KEY),
  email: "user@example.com"
});
```

# Bind to a Worker

Use the account ID when creating other Cloudflare resources.

```ts
import { Worker, AccountId } from "alchemy/cloudflare";

const accountId = await AccountId("my-account", {});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')", 
  accountId: accountId
});
```