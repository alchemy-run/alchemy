# Zone Settings

The Zone Settings resource allows you to manage and configure various settings for a Cloudflare zone. This includes SSL/TLS settings, caching, security features, and more. For more information, visit the [Cloudflare Zone Settings API documentation](https://developers.cloudflare.com/api/resources/zones/settings/).

# Minimal Example

```ts
import { ZoneSettings } from "alchemy/cloudflare";

const zoneSettings = await ZoneSettings("example-zone", {
  name: "example.com",
  settings: {
    ssl: "full",
    alwaysUseHttps: "on",
  },
});
```

# Create the Zone Settings

```ts
import { ZoneSettings } from "alchemy/cloudflare";

const zoneSettings = await ZoneSettings("secure-zone", {
  name: "secure.example.com",
  settings: {
    ssl: "strict",
    alwaysUseHttps: "on",
    automaticHttpsRewrites: "on",
    minTlsVersion: "1.2",
    tls13: "on",
  },
});
```

# Bind to a Worker

```ts
import { Worker, ZoneSettings } from "alchemy/cloudflare";

const myZoneSettings = await ZoneSettings("my-zone-settings", {
  name: "my-app.com",
  settings: {
    ssl: "full",
    alwaysUseHttps: "on",
  },
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myZoneSettings,
  },
});
```