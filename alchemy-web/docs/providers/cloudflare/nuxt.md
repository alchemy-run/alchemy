# Nuxt

Deploy a [Nuxt](https://nuxt.com/) application to Cloudflare Pages with automatically configured defaults.

# Minimal Example

Deploy a basic Nuxt site with default settings:

```ts
import { Nuxt } from "alchemy/cloudflare";

const nuxtSite = await Nuxt("my-nuxt-app");
```

# Deploy with Custom Bindings

Add database and other bindings to your Nuxt app:

```ts
import { Nuxt } from "alchemy/cloudflare";
import { D1Database } from "alchemy/cloudflare";

const db = await D1Database("my-db");

const nuxtSiteWithDb = await Nuxt("my-nuxt-app-with-db", {
  bindings: {
    DB: db,
  }
});
```

# Deploy with Custom Build Command

Customize the build process:

```ts
import { Nuxt } from "alchemy/cloudflare";

const nuxtSite = await Nuxt("my-nuxt-app", {
  command: "npm run build:cloudflare", // Specify a custom build command
  bindings: {
    API_KEY: alchemy.secret(process.env.API_KEY),
  },
  vars: {
    NODE_ENV: "production",
    APP_ENV: "staging"
  }
});
```

# Bind to a Worker

Use the Nuxt site in another Worker:

```ts
import { Worker, Nuxt } from "alchemy/cloudflare";

const nuxtSite = await Nuxt("my-nuxt-app", {
  // ...
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    NUXT: nuxtSite,
  },
});
```