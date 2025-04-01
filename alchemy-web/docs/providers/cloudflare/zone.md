# Zone

The Zone component allows you to manage [Cloudflare Zones](https://developers.cloudflare.com/dns/zone-setups/) for your domain. A Cloudflare Zone represents a domain and its configuration settings on Cloudflare, enabling you to manage DNS, SSL/TLS, caching, security, and other settings.

# Minimal Example

```ts
import { Zone } from "alchemy/cloudflare";

const basicZone = await Zone("example.com", {
  name: "example.com",
  type: "full",
  jumpStart: true,
});
```

# Create the Zone

```ts
import { Zone } from "alchemy/cloudflare";

const secureZone = await Zone("secure.example.com", {
  name: "secure.example.com",
  type: "full",
  settings: {
    ssl: "strict",
    alwaysUseHttps: "on",
    automaticHttpsRewrites: "on",
    minTlsVersion: "1.3",
    tls13: "zrt",
  },
});
```

# Bind to a Worker

```ts
import { Worker, Zone } from "alchemy/cloudflare";

const myZone = await Zone("my-zone", {
  name: "my-zone.com",
  type: "full",
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myZone,
  },
});
```