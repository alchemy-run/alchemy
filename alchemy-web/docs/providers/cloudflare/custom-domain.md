# CustomDomain

The CustomDomain resource lets you bind a [Cloudflare Worker](https://developers.cloudflare.com/workers/platform/routing/custom-domains/) to a custom domain within a Cloudflare zone.

# Minimal Example

Bind a domain to a Cloudflare Worker.

```ts
import { CustomDomain } from "alchemy/cloudflare";

const domain = await CustomDomain("api-domain", {
  name: "api.example.com", 
  zoneId: "YOUR_ZONE_ID",
  workerName: "my-api-worker"
});
```

# Bind to a Worker

```ts
import { Worker, CustomDomain } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "my-api",
  script: "console.log('Hello, world!')"
});

const domain = await CustomDomain("api-domain", {
  name: "api.example.com",
  zoneId: "YOUR_ZONE_ID",
  workerName: worker.name
});
```