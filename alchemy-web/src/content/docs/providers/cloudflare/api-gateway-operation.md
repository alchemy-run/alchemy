---
title: APIGatewayOperation
description: Manage individual API endpoints with Cloudflare's API Gateway
---

Cloudflare's API Gateway Operation resource manages individual API endpoints that can be monitored, secured, and configured through API Shield. Operations represent specific HTTP method + endpoint + host combinations that your API exposes.

:::caution
You should use [`APIShield`](/providers/cloudflare/api-shield) instead of `APIGatewayOperation` for most use cases. It will create and manage the [`APISchema`](/providers/cloudflare/api-schema) and `APIGatewayOperation` resources for you.
:::

## Basic API Operation

Create a simple API endpoint operation:

```typescript
import { APIGatewayOperation, Zone } from "alchemy/cloudflare";

const zone = await Zone("example.com");

const getUserOp = await APIGatewayOperation("get-users", {
  zone,
  endpoint: "/users",
  host: "api.example.com",
  method: "GET"
});
```

## Path Parameters

Use curly braces to define path parameters in your endpoints:

```typescript
const getUserByIdOp = await APIGatewayOperation("get-user-by-id", {
  zone,
  endpoint: "/users/{id}",
  host: "api.example.com",
  method: "GET"
});
```

## Mitigation Actions

Configure how the operation responds to validation failures:

```typescript
// Monitor traffic without blocking
const monitorOp = await APIGatewayOperation("monitor-endpoint", {
  zone,
  endpoint: "/api/users",
  host: "api.example.com",
  method: "GET",
  mitigation: "none"
});

// Log invalid requests (requires paid plan)
const logOp = await APIGatewayOperation("log-endpoint", {
  zone,
  endpoint: "/api/users",
  host: "api.example.com",
  method: "POST",
  mitigation: "log"
});

// Block invalid requests
const blockOp = await APIGatewayOperation("block-endpoint", {
  zone,
  endpoint: "/api/admin",
  host: "api.example.com",
  method: "DELETE",
  mitigation: "block"
});
``` 