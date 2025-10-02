---
title: APISchema
description: Manage OpenAPI v3 schemas for Cloudflare API Gateway validation
---

Cloudflare's API Gateway Schema resource allows you to upload and manage OpenAPI v3 schemas for API validation. These schemas define the structure and validation rules for your API endpoints, enabling Cloudflare to validate incoming requests against your API specification.

:::caution
You should use [`APIShield`](/providers/cloudflare/api-shield/) instead of `APISchema` for most use cases. It will create and manage the `APISchema` and [`APIGatewayOperation`](/providers/cloudflare/api-gateway-operation/) resources for you.
:::

## Basic Schema Upload

Upload an OpenAPI v3 schema to enable API validation for your zone:

```typescript
import { APISchema, Zone } from "alchemy/cloudflare";

const zone = await Zone("example.com");

const apiSchema = await APISchema("my-api-schema", {
  zone,
  name: "my-api-v1",
  schema: {
    openapi: "3.0.0",
    info: {
      title: "My API",
      version: "1.0.0"
    },
    servers: [
      { url: "https://api.example.com" }
    ],
    paths: {
      "/users": {
        get: {
          operationId: "getUsers",
          responses: {
            "200": {
              description: "Success"
            }
          }
        }
      }
    }
  }
});
```

:::caution
Cloudflare only supports OpenAPI `v3.0.x` format. OpenAPI `v3.1+` is not yet supported.
:::

