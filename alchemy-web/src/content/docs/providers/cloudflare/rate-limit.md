---
title: RateLimit
description: Learn how to create and use Cloudflare RateLimit bindings in Alchemy to implement rate limiting in your Workers.
---

A [Cloudflare RateLimit](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) binding provides access to Cloudflare's rate limiting functionality, allowing you to implement rate limiting directly in your Workers without needing to rely on external services.

## Minimal Example

Create a basic rate limit binding with simple configuration.

```ts
import { RateLimit } from "alchemy/cloudflare";

const rateLimit = RateLimit({
  namespace_id: 1001,
  simple: {
    limit: 1500,
    period: 60
  }
});
```

## Bind to a Worker

Attach a rate limit binding to a Worker for rate limiting functionality.

```ts
import { Worker, RateLimit } from "alchemy/cloudflare";

const rateLimit = RateLimit({
  namespace_id: 1001,
  simple: {
    limit: 100,
    period: 60
  }
});

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  bindings: {
    RATE_LIMIT: rateLimit,
  },
});
```

## Usage in Worker

Use the rate limit binding in your Worker to check and enforce rate limits.

```ts
// src/api.ts
import { env } from "cloudflare:workers";

export default {
  async fetch(request: Request): Promise<Response> {
    // Get client IP or user identifier
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    
    // Check rate limit
    const { success } = await env.RATE_LIMIT.limit({
      key: clientIP,
    });
    
    if (!success) {
      return new Response("Rate limit exceeded", { status: 429 });
    }
    
    // Process request normally
    return new Response("Request processed successfully");
  },
};
```

## Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `namespace_id` | `number` | The namespace ID for the rate limit binding |
| `simple.limit` | `number` | The maximum number of requests allowed within the period |
| `simple.period` | `number` | The time period in seconds for the rate limit |

## Runtime Methods

When bound to a Worker, the rate limit binding provides the following methods:

### `limit(options)`

Checks if a request should be rate limited based on the provided key.

**Parameters:**
- `options.key` (string): The key to use for rate limiting (e.g., IP address, user ID)

**Returns:**
- `Promise<{ success: boolean }>`: `success` is `true` if the request is within the rate limit, `false` if it exceeds the limit

```ts
const result = await env.RATE_LIMIT.limit({
  key: "user-123",
});

if (result.success) {
  // Request is within rate limit
} else {
  // Request exceeds rate limit
}
```