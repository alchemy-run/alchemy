# Zone Settings

The Zone Settings component allows you to manage [Cloudflare Zone Settings](https://developers.cloudflare.com/api/resources/zones/settings) for your domain. This includes configuring SSL, HTTP/2, caching, and other settings to optimize and secure your site.

# Minimal Example

```ts
import { ZoneSettings } from "alchemy/cloudflare";

const zoneSettings = await ZoneSettings("example-zone-settings", {
  zoneId: "your-zone-id",
  settings: {
    ssl: "full",
    alwaysUseHttps: "on",
  },
});
```

# Create the Zone Settings

```ts
import { ZoneSettings } from "alchemy/cloudflare";

const zoneSettings = await ZoneSettings("example-zone-settings", {
  zoneId: "your-zone-id",
  settings: {
    ssl: "strict",
    minTlsVersion: "1.2",
    http2: "on",
    http3: "on",
    brotli: "on",
  },
});
```

# Bind to a Worker

```ts
import { Worker, ZoneSettings } from "alchemy/cloudflare";

const myZoneSettings = await ZoneSettings("my-zone-settings", {
  zoneId: "your-zone-id",
  settings: {
    ssl: "flexible",
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