---
title: Tunnel
description: Connect private services securely to the internet without exposing your server's IP address.
---

A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) provides a secure connection between your origin server and Cloudflare's global network without exposing your server's IP address.

## Minimal Example

Create a basic tunnel and run it with the returned token:

```ts
import { Tunnel } from "alchemy/cloudflare";

const tunnel = await Tunnel("my-app", {
  name: "my-app-tunnel",
});

// Run cloudflared with:
// cloudflared tunnel run --token <tunnel.token.unencrypted>
```

## With Ingress Rules

Create a tunnel with routing configuration. DNS records are automatically created for each hostname:

```ts
import { Tunnel } from "alchemy/cloudflare";

const webTunnel = await Tunnel("web-app", {
  name: "web-app-tunnel",
  ingress: [
    {
      hostname: "app.example.com",
      service: "http://localhost:3000",
    },
    {
      service: "http_status:404", // catch-all rule (required by Cloudflare API)
    },
  ],
});

// A CNAME record for app.example.com → {tunnelId}.cfargotunnel.com
// is automatically created in the appropriate zone
```

:::caution
The Cloudflare API requires that the last ingress rule must be a catch-all rule (without hostname or path filters). This is enforced by the API and will result in an error if omitted.
:::

## Multiple Services

Route different paths and hostnames to different services:

```ts
import { Tunnel } from "alchemy/cloudflare";

const apiTunnel = await Tunnel("api", {
  name: "api-tunnel",
  ingress: [
    {
      hostname: "api.example.com",
      path: "/v1/*",
      service: "http://localhost:8080",
      originRequest: {
        httpHostHeader: "api.internal",
        connectTimeout: 30,
      },
    },
    {
      hostname: "api.example.com",
      path: "/v2/*",
      service: "http://localhost:8081",
    },
    {
      hostname: "admin.example.com",
      service: "http://localhost:9000",
    },
    {
      service: "http_status:404",
    },
  ],
});
```

## Private Network Access

Enable WARP routing for private network connectivity:

```ts
import { Tunnel } from "alchemy/cloudflare";

const privateTunnel = await Tunnel("private-network", {
  name: "private-network-tunnel",
  warpRouting: {
    enabled: true,
  },
});
```

## Origin Configuration

Configure how the tunnel connects to your origin servers:

```ts
import { Tunnel } from "alchemy/cloudflare";

const secureTunnel = await Tunnel("secure", {
  name: "secure-tunnel",
  originRequest: {
    noTLSVerify: false,
    connectTimeout: 30,
    httpHostHeader: "internal.service",
    http2Origin: true,
    keepAliveConnections: 10,
  },
  ingress: [
    {
      hostname: "secure.example.com",
      service: "https://localhost:8443",
    },
    {
      service: "http_status:404",
    },
  ],
});
```

## Per-Rule Configuration

Apply different origin settings to specific routes:

```ts
import { Tunnel } from "alchemy/cloudflare";

const mixedTunnel = await Tunnel("mixed", {
  name: "mixed-tunnel",
  ingress: [
    {
      hostname: "fast.example.com",
      service: "http://localhost:3000",
      originRequest: {
        connectTimeout: 10,
        keepAliveTimeout: 90,
      },
    },
    {
      hostname: "secure.example.com",
      service: "https://localhost:8443",
      originRequest: {
        caPool: "/path/to/ca.pem",
        noTLSVerify: false,
      },
    },
    {
      service: "http_status:404",
    },
  ],
});
```

## Adopting Existing Tunnels

Take over management of an existing tunnel:

```ts
import { Tunnel } from "alchemy/cloudflare";

const existingTunnel = await Tunnel("existing", {
  name: "existing-tunnel",
  adopt: true, // Won't fail if tunnel already exists
  ingress: [
    {
      hostname: "updated.example.com",
      service: "http://localhost:5000",
    },
    {
      service: "http_status:404",
    },
  ],
});
```

## With Custom Secret

Provide your own tunnel secret:

```ts
import alchemy from "alchemy";
import { Tunnel } from "alchemy/cloudflare";

const tunnel = await Tunnel("custom-secret", {
  name: "custom-secret-tunnel",
  tunnelSecret: alchemy.secret("your-secret-value"),
  ingress: [
    {
      hostname: "app.example.com",
      service: "http://localhost:3000",
    },
    {
      service: "http_status:404",
    },
  ],
});
```

## Running the Tunnel

After creating a tunnel, use the returned token to run cloudflared:

```bash
# Using the token (recommended)
cloudflared tunnel run --token <tunnel.token.unencrypted>

# Or using credentials file (for locally-managed tunnels)
cloudflared tunnel run <tunnel-name>
```

## Automatic DNS Management

The Tunnel resource automatically creates DNS CNAME records for hostnames specified in ingress rules:

```ts
import { Tunnel } from "alchemy/cloudflare";

const appTunnel = await Tunnel("app", {
  name: "app-tunnel",
  ingress: [
    {
      hostname: "app.example.com",
      service: "http://localhost:3000",
    },
    {
      hostname: "api.example.com",
      service: "http://localhost:8080",
    },
    {
      service: "http_status:404",
    },
  ],
});

// DNS CNAME records are automatically created:
// - app.example.com → {tunnelId}.cfargotunnel.com
// - api.example.com → {tunnelId}.cfargotunnel.com
```

For advanced DNS configurations, omit hostnames from ingress rules and manage DNS records separately:

```ts
import { Tunnel, DnsRecords } from "alchemy/cloudflare";

const tunnel = await Tunnel("manual-dns", {
  name: "manual-dns-tunnel",
  ingress: [
    {
      service: "http://localhost:3000",
    },
    {
      service: "http_status:404",
    },
  ],
});

// Create DNS records with custom configuration
const dns = await DnsRecords("tunnel-dns", {
  zone: "example.com",
  records: [
    {
      name: "app",
      type: "CNAME",
      content: `${tunnel.tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1, // Auto TTL
    },
  ],
});
```

## Configuration Management

Tunnels can be configured in two ways:

### Remotely-Managed (Default)

Configuration is stored in Cloudflare and managed via API:

```ts
import { Tunnel } from "alchemy/cloudflare";

const remoteTunnel = await Tunnel("remote", {
  name: "remote-tunnel",
  configSrc: "cloudflare", // Default
  ingress: [...],
});
```

### Locally-Managed

Configuration is managed via local config files:

```ts
import { Tunnel } from "alchemy/cloudflare";

const localTunnel = await Tunnel("local", {
  name: "local-tunnel",
  configSrc: "local",
  // Ingress rules are ignored for locally-managed tunnels
});

// Configure via ~/.cloudflared/config.yml or specify --config flag
```

## Tunnel Properties

### Ingress Rule Options

| Property | Type | Description |
|----------|------|-------------|
| `hostname` | `string` | Hostname to match (omit for catch-all) |
| `service` | `string` | Service URL or status (e.g., `http://localhost:8080`, `http_status:404`) |
| `path` | `string` | Path pattern to match |
| `originRequest` | `object` | Origin configuration for this rule |

### Origin Request Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `connectTimeout` | `number` | 30 | Timeout for origin connection (seconds) |
| `tlsTimeout` | `number` | 10 | Timeout for TLS handshake (seconds) |
| `httpHostHeader` | `string` | - | Override Host header sent to origin |
| `noTLSVerify` | `boolean` | false | Disable TLS certificate verification |
| `http2Origin` | `boolean` | false | Use HTTP/2 for origin connections |
| `keepAliveConnections` | `number` | 100 | Number of keep-alive connections |
| `keepAliveTimeout` | `number` | 90 | Keep-alive timeout (seconds) |
| `proxyProtocol` | `string` | "off" | Proxy protocol version ("off", "v1", "v2") |

## Tunnel Lifecycle

1. **Create**: Generates tunnel credentials and optional configuration
2. **Update**: Modifies configuration (names are immutable)
3. **Delete**: Removes tunnel and cleans up DNS records
4. **Adopt**: Takes over existing tunnel management

:::note
Tunnel names cannot be changed after creation. Attempting to change the name will trigger a replacement.
:::

:::tip
Use the `adopt: true` option when migrating existing tunnels to Alchemy management.
:::
