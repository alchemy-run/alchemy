---
title: Zone
description: Learn how to manage your Cloudflare Zones (domains) including DNS settings and other configurations using Alchemy.
---

The Zone resource lets you manage [Cloudflare DNS zones](https://developers.cloudflare.com/dns/zone-setups/) and their configuration settings.

## Minimal Example

Create a basic DNS zone with default settings.

```ts
import { Zone } from "alchemy/cloudflare";

const zone = await Zone("example-zone", {
  name: "example.com",
  type: "full",
  delete: true, //Default true: Delete's Zone on --destroy
});
```

## Enhanced Security Settings

Configure a zone with strict SSL and enhanced security settings.

```ts
const secureZone = await Zone("secure-zone", {
  name: "secure.example.com",
  settings: {
    ssl: "strict",
    alwaysUseHttps: "on",
    minTlsVersion: "1.3",
    tls13: "zrt",
  },
});
```

## Performance Optimization

Create a zone optimized for performance with HTTP/3 and caching.

```ts
const fastZone = await Zone("fast-zone", {
  name: "fast.example.com",
  settings: {
    browserCacheTtl: 7200,
    brotli: "on",
    http3: "on",
    earlyHints: "on",
  },
});
```

## Bot Management

Configure a zone for development with specific features enabled.

```ts
const devZone = await Zone("dev-zone", {
  name: "dev.example.com",
  settings: {
    developmentMode: "on",
    websockets: "on",
    hotlinkProtection: "on",
  },
  botManagement: {
    fightMode: true,
    aiBotsProtection: "block",
    crawlerProtection: "enabled",
    enableJs: true,
    isRobotsTxtManaged: true,
    optimizeWordpress: false,
    suppressSessionScore: false,
  },
});
```

### Bot Management options

- **fightMode**: Enable/disable Bot Fight Mode (maps to `fight_mode`).
- **aiBotsProtection**: AI bot behavior: `block` or `none` (maps to `ai_bots_protection`).
- **crawlerProtection**: Enable/disable crawler protection: `enabled` or `disabled` (maps to `crawler_protection`).
- **enableJs**: Require JavaScript challenges (maps to `enable_js`).
- **isRobotsTxtManaged**: Manage robots.txt via Cloudflare (maps to `is_robots_txt_managed`).
- **optimizeWordpress**: Optimize protections for WordPress (maps to `optimize_wordpress`).
- **suppressSessionScore**: Suppress session score collection (maps to `suppress_session_score`).

Advanced plans may also use Super Bot Fight Mode settings:

- **sbfmLikelyAutomated**: Action for likely automated traffic: `allow` | `block` | `challenge` (maps to `sbfm_likely_automated`).
- **sbfmDefinitelyAutomated**: Action for definitely automated traffic: `allow` | `block` | `challenge` (maps to `sbfm_definitely_automated`).
- **sbfmVerifiedBots**: Handling for verified bots: `allow` | `challenge` (maps to `sbfm_verified_bots`).
- **sbfmStaticResourceProtection**: Protect static resources (maps to `sbfm_static_resource_protection`).
- **autoUpdateModel**: Automatically update detection model (maps to `auto_update_model`).
