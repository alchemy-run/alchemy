# CustomDomain

The CustomDomain resource lets you configure [custom domains for Cloudflare Workers](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

# Minimal Example

Bind a domain to a Cloudflare Worker.

```ts
import { Worker, CustomDomain } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "my-api-worker",
  entrypoint: "./src/api-worker.ts"
});

const domain = await CustomDomain("api-domain", {
  name: "api.example.com", 
  zoneId: "YOUR_ZONE_ID",
  workerName: worker.name
});
```

# With Environment

Configure a domain binding for a specific Worker environment.

```ts
import { Worker, CustomDomain } from "alchemy/cloudflare";

const domain = await CustomDomain("staging-domain", {
  name: "staging-api.example.com",
  zoneId: "YOUR_ZONE_ID", 
  workerName: "my-worker",
  environment: "staging"
});
```