# CustomDomain

The CustomDomain resource lets you bind a [Cloudflare Worker](https://developers.cloudflare.com/workers/platform/routing/custom-domains/) to a custom domain within a Cloudflare zone.

# Minimal Example

Bind a domain to a Cloudflare Worker:

```ts
import { CustomDomain } from "alchemy/cloudflare";

const domain = await CustomDomain("api-domain", {
  name: "api.example.com", 
  zoneId: "YOUR_ZONE_ID",
  workerName: "my-api-worker"
});
```

# Bind to a Static Site

Bind a domain to a Cloudflare Static Site:

```ts
import { StaticSite, CustomDomain } from "alchemy/cloudflare";

const site = await StaticSite("landing-page", {
  name: "my-landing-page",
  dir: "./dist"
});

const domain = await CustomDomain("site-domain", {
  name: "www.example.com",
  zoneId: "YOUR_ZONE_ID", 
  workerName: site.name
});
```

# Bind to a Worker

```ts
import { Worker, CustomDomain } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "my-api",
  script: "export default { fetch() { return new Response('Hello') } }"
});

const domain = await CustomDomain("api-domain", {
  name: "api.example.com",
  zoneId: "YOUR_ZONE_ID",
  workerName: worker.name
});
```