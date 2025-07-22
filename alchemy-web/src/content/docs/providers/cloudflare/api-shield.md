---
title: APIShield
description: Protect your API endpoints with OpenAPI and API Shield
---

Cloudflare's API Shield protects your API endpoints by validating incoming requests against an OpenAPI v3 schema. It can monitor, log, or block requests that don't match your schema definition, helping prevent malformed requests and potential security issues.

:::note
See Cloudflare's official [API Shield documentation](https://developers.cloudflare.com/api-shield/) for more information.
:::

## Schema Validation

Construct an APIShield from an OpenAPI v3 schema. The schema can be provided as a string, a file path, a URL, or a typed OpenAPI object.

For example, given the following `schema.yaml` file:

```yaml
openapi: 3.0.0
info:
  title: My API
  version: 1.0.0
servers:
  - url: https://api.example.com
paths:
  /users:
    get:
      operationId: getUsers
      responses:
        '200':
          description: Success
  /users/{id}:
    get:
      operationId: getUser
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: User details
```

You can construct and configure an `APIShield` for your Cloudflare [`Zone`](/providers/cloudflare/zone) with the following code:

```typescript
import { APIShield, Zone } from "alchemy/cloudflare";

const zone = await Zone("example.com");

const apiShield = await APIShield("api-validation", {
  zone,
  // or by domain name:
  // zone: "example.com",
  schema: "./schema.yaml",
});
```

:::caution
The schema must be valid OpenAPI `v3.0.x` format. Cloudflare does not support `v3.1+` yet.
:::


### From a File

```ts
const apiShield = await APIShield("api-validation", {
  zone,
  schema: "./schema.yaml",
});
```

### From a URL

```ts
const apiShield = await APIShield("api-validation", {
  zone,
  schema: "https://api.example.com/openapi.yaml",
  // or:
  // schema: new URL("https://api.example.com/openapi.yaml"),
});
```

### From a YAML String

```ts
const apiShield = await APIShield("api-validation", {
  zone,
  schema: `
    openapi: 3.0.0
    info:
      title: My API
      version: 1.0.0
    paths:
      # ... etc.
  `,
});
```

### From a JSON String

```ts
const apiShield = await APIShield("api-validation", {
  zone,
  schema: `
    {
      "openapi": "3.0.0",
      "info": {
        "title": "My API",
        "version": "1.0.0"
      },
      "paths": {
        // ... etc.
      }
    }
  `,
});
```

### From an Object

```ts
const apiShield = await APIShield("api-validation", {
  zone,
  schema: {
    openapi: "3.0.0",
    info: {
      title: "My API",
      version: "1.0.0",
    },
    paths: {
      "/users": {
        get: {
          operationId: "getUsers",
        },
      },
    },
  },
});
```

## Mitigation Actions

API Shield supports three mitigation actions:

- `none`: Monitor and analyze API traffic without impact
- `log`: Track non-compliant requests for analysis
- `block`: Actively protect endpoints by blocking invalid requests

## Default Mitigation

Each API Endpoint in the schema (path + HTTP method) will be configured with a default mitigation action of `"none"`, but you can override this with the `defaultMitigation` option.

```ts
const apiShield = await APIShield("api-validation", {
  zone,
  schema: "./schema.yaml",
  defaultMitigation: "log" // Log violations (requires paid plan)
});
```

## Unknown Operation Mitigation

Use the `unknownOperationMitigation` option to configure the action for requests that don't match any operation in the schema:

```ts
const apiShield = await APIShield("api-validation", {
  zone,
  schema: "./schema.yaml",
  unknownOperationMitigation: "log" // Log requests to undefined endpoints
});
```

## Endpoint Mitigations

Use the `mitigations` option to configure different actions for specific endpoints and methods:

```ts
const apiShield = await APIShield("api-validation", {
  zone,
  schema: "./schema.yaml",
  mitigations: {
    // apply to all methods on the /users path
    "/users": "log",
    "/users/{id}": {
      // block invalid POST requests to /users/{id}
      post: "block",
      // log invalid GET requests to /users/{id}
      get: "log"
    }
  }
});
```

## Disable Validation

Use the `enabled` option to disable validation for the APIShield:

```ts
const apiShield = await APIShield("api-validation", {
  zone,
  schema: "./schema.yaml",
  enabled: false, // Disable validation
});
```