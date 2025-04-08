---
order: 4
---
# DNS & Zone

This guide is Part 4 in our Cloudflare and Alchemy series. We'll set up a Cloudflare Zone for a custom domain.

**Previous Tutorial**: [Working with Durable Objects](./durable-object.md) (Part 3)

## Creating a Zone

Add a Zone resource to your `alchemy.run.ts`:

```typescript
import { Zone } from "alchemy/cloudflare";

// Create a zone for your domain
export const zone = await Zone("my-domain", {
  name: "example.com", // Replace with your actual domain
  type: "full",
  settings: {
    // Common security settings
    ssl: "flexible",
    alwaysUseHttps: "on",
    minTlsVersion: "1.2",
    
    // Performance settings
    brotli: "on",
    zeroRtt: "on",
  },
});
```

## Adding DNS Records

Add DNS records for your domain:

```typescript
import { DnsRecords } from "alchemy/cloudflare";

// Add DNS records
await DnsRecords("app-dns", {
  zoneId: zone.id,
  records: [
    {
      type: "A",
      name: "@",               // Apex domain (example.com)
      content: "192.0.2.1",    // Replace with your server IP
      ttl: 3600,
      proxied: true,
    },
    {
      type: "CNAME",
      name: "www",             // www subdomain
      content: "example.com",  // Points to apex domain
      ttl: 3600,
      proxied: true,
    },
  ],
});
```

## Using a Custom Domain

Update your StaticSite to use your custom domain:

```typescript
// Update the StaticSite to use a custom domain
export const website = await StaticSite("Website", {
  name: "my-cloudflare-app",
  dir: "./dist",
  build: {
    command: "bun run build",
  },
  domain: "www.example.com", // Your custom domain
  routes: {
    "/api/*": api,
  },
});
```

## Common Zone Settings

Here are some useful zone settings:

```typescript
settings: {
  // Security
  ssl: "strict",               // off, flexible, full, strict
  alwaysUseHttps: "on",        // on, off
  minTlsVersion: "1.2",        // 1.0, 1.1, 1.2, 1.3
  
  // Performance
  browserCacheTtl: 7200,       // Browser cache TTL in seconds
  brotli: "on",                // Brotli compression: on, off
  
  // Features
  ipv6: "on",                  // IPv6 support: on, off
  websockets: "on",            // WebSocket support: on, off
  developmentMode: "off",      // Disable caching: on, off
}
```

## Importing Existing DNS Records

If you have existing DNS records to migrate:

```typescript
import { ImportDnsRecords } from "alchemy/cloudflare";

// Import DNS records from a BIND zone file
const { records } = await ImportDnsRecords("imported-dns", {
  domain: "example.com",
});

// Filter out unsupported record types and use them
await DnsRecords("transfer-dns-records", {
  zoneId: zone.id,
  records: records.filter(r => r.type !== "SOA"),
});
```

## Deploy Your App

Deploy everything with one command:

```bash
bun ./alchemy.run.ts
```

Your app will now be accessible at both its Cloudflare Pages URL and your custom domain.

## Configuring Your Domain Registrar

For the custom domain to work, update your domain's nameservers at your registrar to use Cloudflare's nameservers (typically ns1.cloudflare.com through ns5.cloudflare.com).
