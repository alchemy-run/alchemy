---
title: Secret
description: Learn how to add individual secrets to Cloudflare Secrets Store for fine-grained secret management.
---

A [Cloudflare Secret](https://developers.cloudflare.com/api/resources/secrets_store/subresources/stores/subresources/secrets/) creates an individual secret stored in a [Secrets Store](/providers/cloudflare/secrets-store). If you want to reference an existing Secrets Store secret that was not created using Alchemy, use `SecretRef`.

## Basic Usage

```ts
import { Secret } from "alchemy/cloudflare";

const mySecret = await Secret("my-secret", {
  value: alchemy.secret(process.env.MY_SECRET),
});
```

:::tip
This will auto-create a Secrets Store, `default_secrets_store` if one does not exist. Cloudflare's UI does the same.
:::

Then bind the Secret to your Worker:

```ts
export const worker = await Worker("worker", {
  bindings: {
    MY_SECRET: mySecret,
  },
});
```

And use it at runtime:

```ts
import type { worker } from "../alchemy.run.ts";

export default {
  async fetch(request, env: typeof worker.Env) {
    const secret = await env.MY_SECRET.get();

    // ..
  },
};
```

## Referencing an Existing Secret (SecretRef)

Use `SecretRef` to bind an existing secret by name without creating or updating its value.

```ts
import { SecretRef, Worker } from "alchemy/cloudflare";

const apiKeyRef = await SecretRef({ name: "API_KEY" });

const worker = await Worker("worker", {
  bindings: {
    API_KEY: apiKeyRef,
  },
  entrypoint: "./src/worker.ts",
  url: true,
});
```

At runtime, it behaves the same:

```ts
export default {
  async fetch(request, env) {
    const key = await env.API_KEY.get();
    return new Response(key ? "ok" : "missing");
  }
};
```

## Custom Secrets Store

By default, the `default_secrets_store` will be used, but you can also specify your own store.

```ts
import { Secret, SecretsStore } from "alchemy/cloudflare";

const store = await SecretsStore("my-store");

const mySecret = await Secret("my-secret", {
  store,
  value: alchemy.secret(process.env.MY_SECRET),
});
```

Or, if the secret already exists, reference it with `SecretRef` and pass the store explicitly:

```ts
import { SecretRef, SecretsStore, Worker } from "alchemy/cloudflare";

const store = await SecretsStore("my-store", {
  name: "production-secrets",
  adopt: true,
});

const apiKeyRef = await SecretRef({
  name: "API_KEY",
  store,
});
```

:::caution
During the Beta, Cloudflare does not support more than one [SecretsStore](/providers/cloudflare/secrets-store) per account, so you should instead rely on the default behavior until then.
:::
