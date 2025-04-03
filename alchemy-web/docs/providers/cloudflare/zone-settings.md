# Zone Settings

The Zone Settings component allows you to manage [Cloudflare Zone Settings](https://developers.cloudflare.com/dns/zone-setups/) for your domain. This includes configuring SSL/TLS, caching, security, and other settings to optimize and secure your domain.

# Minimal Example

```ts
import { Zone } from "alchemy/cloudflare";

const myZone = await Zone("example.com", {
  name: "example.com",
  type: "full",
  jumpStart: true,
});
```

# Create the Zone Settings

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
  settings: {
    ssl: "full",
    alwaysUseHttps: "on",
  },
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myZone,
  },
});
```