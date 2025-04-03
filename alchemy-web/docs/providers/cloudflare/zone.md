# Zone

The Zone resource lets you manage [Cloudflare Zones](https://developers.cloudflare.com/dns/zone-setups/) which represent domains and their configuration settings on Cloudflare.

# Minimal Example

Create a basic zone with default settings:

```ts
import { Zone } from "alchemy/cloudflare";

const zone = await Zone("example.com", {
  name: "example.com",
  type: "full",
  jumpStart: true
});
```

# Create a Zone with Enhanced Security

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
    tls13: "zrt"
  }
});
```

# Create a Zone with Performance Settings

```ts
import { Zone } from "alchemy/cloudflare";

const fastZone = await Zone("fast.example.com", {
  name: "fast.example.com",
  settings: {
    browserCacheTtl: 7200,
    brotli: "on", 
    zeroRtt: "on",
    http2: "on",
    http3: "on",
    earlyHints: "on"
  }
});
```

# Create a Development Zone

```ts
import { Zone } from "alchemy/cloudflare";

const devZone = await Zone("dev.example.com", {
  name: "dev.example.com",
  settings: {
    developmentMode: "on",
    emailObfuscation: "on",
    hotlinkProtection: "on",
    ipv6: "on",
    websockets: "on"
  }
});
```