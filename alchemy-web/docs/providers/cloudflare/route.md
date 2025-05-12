---
title: Managing Cloudflare Routes with Alchemy
description: Learn how to configure Cloudflare Routes for your Workers using Alchemy to map URL patterns to Worker scripts.
---

# Route

The Route resource lets you map URL patterns to [Cloudflare Workers](https://developers.cloudflare.com/workers/configuration/routing/routes/).

# Minimal Example

Map a domain pattern to a Worker:

```ts
import { Route } from "alchemy/cloudflare";

const route = await Route("api-route", {
  pattern: "api.example.com/*", 
  script: "my-worker",
  zoneId: "your-zone-id"
});
```

# Route with Worker Resource

Use a Worker resource directly:

```ts
import { Worker, Route } from "alchemy/cloudflare";

const worker = await Worker("api", {
  script: `
    export default {
      fetch(request) {
        return new Response("Hello from API!");
      }
    }
  `
});

const route = await Route("api-route", {
  pattern: "api.example.com/*",
  script: worker,
  zoneId: "your-zone-id"
});
```

# Bind to a Worker

Routes are automatically bound to the specified Worker:

```ts
import { Worker, Route } from "alchemy/cloudflare";

const route = await Route("my-route", {
  pattern: "api.example.com/*",
  script: "my-worker",
  zoneId: "your-zone-id"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myRoute: route
  }
});
```