---
order: 0
title: Cloudflare Auth
description: Configure Cloudflare authentication for your Alchemy applications. Learn to use API tokens, OAuth, or global API keys to securely manage Cloudflare resources.
---

# Cloudflare Auth

There are three supported ways of authorizing Alchemy with Cloudflare:
1. API Token - a token you create once with limited scopes
2. OAuth - a token created by `wrangler login`
3. Global API Key (legacy) - the global, highly permissive API key

## API Token

First you need to [create an API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) and then use it in your Alchemy app.

By default, Alchemy will use the `CLOUDFLARE_API_TOKEN` environment variable if set.

You can store the token in your `.env` file
```sh
CLOUDFLARE_API_TOKEN=<token>
```

Or set when running your script:
```sh
CLOUDFLARE_API_TOKEN=<token> bun ./alchemy.run.ts
```

You can explciitly set an `apiToken` when creating a Cloudflare Resource, such as a `Worker`:

```ts
await Worker("my-worker", {
  apiToken: alchemy.secret(process.env.MY_TOKEN)
});
```

## OAuth Token

If you don't specify `CLOUDFLARE_API_KEY` or `CLOUDFLARE_API_TOKEN`, then Alchemy will use the OAuth Token and Refresh Token to authenticate with Cloudflare.

First, make sure you've logged in with wrangler:
```sh
wrangler login
```

Then, run your script (without `CLOUDFLARE_API_KEY` or `CLOUDFLARE_API_TOKEN` environment variables):
```sh
bun ./alchemy.run.ts
```

## Global API Key

After you verify your Cloudflare Account's Email, you will be given a [Global API Key](https://developers.cloudflare.com/fundamentals/api/get-started/keys/).

> [!CAUTION]
> These keys have several limitations that make them less secure than API tokens. Whenever possible, use API tokens to interact with the Cloudflare API. 
>
> See [Cloudflare's API Docs](https://developers.cloudflare.com/api/).

By default, Alchemy will use the `CLOUDFLARE_API_KEY` environment variable if set.

You can store the token in your `.env` file
```sh
CLOUDFLARE_API_KEY=<token>
```

Or set when running your script:
```sh
CLOUDFLARE_API_KEY=<token> bun ./alchemy.run.ts
```

You can explciitly set an `apiKey` when creating a Cloudflare Resource, such as a `Worker`:

```ts
await Worker("my-worker", {
  apiKey: alchemy.secret(process.env.MY_GLOBAL_KEY)
});
```

## Email

When using [Global API Keys](#global-api-key), Alchemy must be configured with the API Key's email.

By default, Alchemy will use the `CLOUDFLARE_EMAIL` if set

```sh
CLOUDFLARE_EMAIL=me@example.com CLOUDFLARE_API_KEY=<token> bun ./alchemy.run.ts
```

You can explicitly set `email` when creating a Cloudlfare Resource:

```ts
await Worker("my-worker", {
  apiKey: alchemy.secret(process.env.MY_GLOBAL_KEY),
  email: "me@example.com"
});
```

## Account ID

By default, Alchemy will resolve the account ID from the API or OAuth token.

```sh
# will use wrangler login and resolve the first account you have acces to (ideal for personal accounts)
bun ./alchemy.run.ts
```

> [!CAUTION]
> If your token has access to more than one account, Alchemy chooses the first one arbitrarily.

You can override the default account ID with the `CLOUDFLARE_ACCOUNT_ID` environment variable:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> bun ./alchemy.run.ts
```

Or by setting `accountId` when creating a Cloudflare Resource:
```ts
await Worker("my-worker", {
  accountId: "my-account-id",
});
```


