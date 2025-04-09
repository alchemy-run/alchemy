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

# Enhanced Security Settings

Configure a zone with strict SSL and enhanced security:

```ts
import { Zone } from "alchemy/cloudflare";

const secureZone = await Zone("secure.example.com", {
  name: "secure.example.com", 
  settings: {
    ssl: "strict",
    alwaysUseHttps: "on",
    automaticHttpsRewrites: "on",
    minTlsVersion: "1.3",
    tls13: "zrt"
  }
});
```

# Performance Optimization

Create a zone optimized for performance:

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

# Development Configuration

Configure a zone for development with specific features enabled:

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