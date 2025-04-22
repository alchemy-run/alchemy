# Zone

The [Cloudflare Zone](https://developers.cloudflare.com/dns/zone-setups/) resource lets you manage domains and their configuration settings on Cloudflare.

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

# Development Zone

Configure a zone for development with specific features:

```ts
const devZone = await Zone("dev.example.com", {
  name: "dev.example.com",
  settings: {
    developmentMode: "on",
    emailObfuscation: "on",
    hotlinkProtection: "on",
    websockets: "on"
  }
});
```