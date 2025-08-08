---
title: Ruleset
description: Manage Cloudflare Rulesets for WAF, rate limiting, transformations, and custom firewall rules using Alchemy.
---

The Ruleset resource lets you manage [Cloudflare Rulesets](https://developers.cloudflare.com/ruleset-engine/) to configure rules for various phases like rate limiting, firewall protection, transforms, and more within a zone's entrypoint ruleset.

:::caution
A Ruleset will overwrite the entire entrypoint ruleset for the specified phase. All existing rules in that phase will be replaced with the rules you provide.
:::

## Custom Firewall Rules

Create custom firewall rules to block malicious traffic and challenge suspicious requests.

```ts
const firewall = await Ruleset("custom-firewall", {
  zone: "example.com",
  phase: "http_request_firewall_custom",
  rules: [
    {
      description: "Block bad IPs",
      expression: "ip.src in {1.2.3.4 1.2.3.5}",
      action: "block"
    },
    {
      description: "Challenge suspicious requests",
      expression: "cf.threat_score > 50",
      action: "challenge"
    }
  ]
});
```

## Request Transforms

Transform incoming requests by modifying headers, URLs, or other request properties.

```ts
const transforms = await Ruleset("header-transforms", {
  zone: "example.com",
  phase: "http_request_transform",
  rules: [
    {
      description: "Add custom header",
      expression: "true",
      action: "rewrite",
      action_parameters: {
        headers: {
          "X-Custom-Header": { value: "my-value" }
        }
      }
    },
    {
      description: "Rewrite API paths",
      expression: 'http.request.uri.path matches "^/v1/"',
      action: "rewrite",
      action_parameters: {
        uri: {
          path: {
            expression: 'regex_replace(http.request.uri.path, "^/v1/", "/api/v1/")'
          }
        }
      }
    }
  ]
});
```

## Rate Limiting

Configure sophisticated rate limiting with multiple characteristics and custom timeouts.

```ts
const advancedRateLimit = await Ruleset("advanced-rate-limit", {
  zone: "example.com",
  phase: "http_ratelimit",
  name: "Advanced API Protection",
  description: "Multi-tier rate limiting for different endpoints",
  rules: [
    {
      description: "Strict rate limit for auth endpoints",
      expression: '(http.request.uri.path wildcard r"/auth/*")',
      action: "block",
      ratelimit: {
        characteristics: ["ip.src", "http.request.headers[\"user-agent\"]"],
        period: 300,
        requests_per_period: 5,
        mitigation_timeout: 3600
      }
    },
    {
      description: "General API rate limit",
      expression: '(http.request.uri.path wildcard r"/api/*")',
      action: "block",
      ratelimit: {
        characteristics: ["ip.src"],
        period: 60,
        requests_per_period: 1000,
        mitigation_timeout: 60
      }
    }
  ]
});
```

## Response Transforms

Modify outgoing responses using response phase rulesets.

```ts
const responseTransforms = await Ruleset("response-transforms", {
  zone: "example.com",
  phase: "http_response_headers_transform",
  rules: [
    {
      description: "Add security headers",
      expression: "true",
      action: "rewrite",
      action_parameters: {
        headers: {
          "X-Frame-Options": { value: "DENY" },
          "X-Content-Type-Options": { value: "nosniff" },
          "Strict-Transport-Security": { 
            value: "max-age=31536000; includeSubDomains" 
          }
        }
      }
    }
  ]
});
```

## Using Zone Resource

Reference an existing zone resource instead of using a zone name.

```ts
import { Ruleset, Zone } from "alchemy/cloudflare";

const zone = await Zone("my-zone", {
  name: "example.com",
  type: "full"
});

const ruleset = await Ruleset("zone-ruleset", {
  zone: zone,
  phase: "http_request_firewall_custom",
  rules: [
    {
      description: "Custom protection",
      expression: "http.request.uri.path eq \"/admin\"",
      action: "block"
    }
  ]
});
```

## Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `zone` | `string \| Zone` | The zone to apply the ruleset to |
| `phase` | `RulePhase` | The phase of the ruleset (defaults to "http_ratelimit") |
| `rules` | `Array<Rule>` | Rules to apply in the ruleset |
| `name` | `string` | Human-readable name for the ruleset |
| `description` | `string` | Description of the ruleset |

## Common Rule Phases

- **`http_ratelimit`** - Rate limiting rules
- **`http_request_firewall_custom`** - Custom firewall rules  
- **`http_request_transform`** - Request transformation rules
- **`http_response_headers_transform`** - Response header modification
- **`http_request_redirect`** - URL redirect rules
- **`http_request_cache_settings`** - Cache configuration rules

:::tip
Rules are executed in the order they appear in the array. Place more specific rules before general ones to ensure proper matching.
:::

:::note
The Ruleset resource overwrites the entire entrypoint ruleset for the specified phase. All existing rules in that phase will be replaced with the rules you provide.
:::

:::caution
Rule expressions use Cloudflare's Rules language. See the [Rules language documentation](https://developers.cloudflare.com/ruleset-engine/rules-language/) for syntax details and available fields.
:::
