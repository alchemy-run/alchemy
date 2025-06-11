---
order: 3
title: State
description: Understand how Alchemy tracks and manages infrastructure state using transparent, pluggable storage. Learn about state files, customizing storage backends, and securing sensitive data.
---

# State

Alchemy uses a transparent and pluggable state management system to track resource lifecycles and enable idempotent operations. It's designed to be simple, with multiple backend options ranging from local files to cloud storage.

## What is State in Alchemy?

State in Alchemy consists of resource data that tracks the current status, properties, and outputs of each resource. By default, it's stored in JSON files in a `.alchemy` directory, organized by app and stage:

```
.alchemy/
  my-app/
    dev/
      my-resource.json
      my-other-resource.json
```

## State File Structure

Each state file contains the full information about a resource:

```json
{
  "provider": "service::ResourceName",
  "data": {},
  "status": "updated",
  "output": {
    "id": "resource-123",
    "name": "My Resource",
    "createdAt": 1679012345678
  },
  "props": {
    "name": "My Resource",
    "description": "This is a test resource"
  }
}
```

The state file includes:

- **provider**: The resource type identifier
- **data**: Internal provider-specific data
- **status**: Current lifecycle status (created, updated, deleted)
- **output**: The resource's current output values
- **props**: The resource's input properties

## How Alchemy Uses State

Alchemy uses state to determine the appropriate action for each resource:

1. **No state file**: The resource is created
2. **State exists + props unchanged**: The resource is skipped
3. **State exists + props changed**: The resource is updated
4. **Resource removed from code**: The resource is deleted

This approach enables idempotent operations - running the same code multiple times produces the same result, avoiding duplicate resource creation.

## State Location

By default, Alchemy stores state files in the `.alchemy` directory in your project root. This approach has several benefits:

- **Transparency**: State files are plain JSON and can be inspected and modified manually
- **Versioning**: State can be committed to source control with your code
- **Portability**: No external service dependencies required

## State Inspection

State files can be directly inspected:

```bash
cat .alchemy/my-app/dev/my-resource.json
```

This transparency helps with debugging and understanding what Alchemy is doing.

## Customizing State Storage

### Change `.alchemy` directory location

Perhaps you want to change the location of the `.alchemy` directory in a monorepo.

```typescript
const app = await alchemy("my-app", {
  stateStore: (scope) => new FileSystemStateStore(scope, {
    rootDir: path.resolve(import.meta.dir, "..", ".alchemy")
  })
});
```

### Durable Objects State Store (Recommended)

For high-performance cloud state storage, use DOStateStore with Cloudflare Durable Objects.

```typescript
import { DOStateStore } from "alchemy/cloudflare";

// Set CLOUDFLARE_API_KEY, CLOUDFLARE_EMAIL, and ALCHEMY_STATE_TOKEN env vars
const app = await alchemy("my-app", {
  stage: "prod",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  stateStore: (scope) => new DOStateStore(scope)
});
```

> [!TIP]
> Credentials can be inferred from environment variables or OAuth. See the [Cloudflare Auth Guide](../guides/cloudflare-auth.md) for setup instructions.

You can also provide explicit configuration:

```typescript
import { DOStateStore } from "alchemy/cloudflare";

const app = await alchemy("my-app", {
  stage: "prod", 
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  stateStore: (scope) => new DOStateStore(scope, {
    // Cloudflare API credentials
    apiKey: alchemy.secret(process.env.CLOUDFLARE_API_KEY),
    email: process.env.CLOUDFLARE_EMAIL,
    // Optional: customize worker name (defaults to "alchemy-state")
    worker: {
      name: "my-app-state"
    }
  })
});
```

DOStateStore automatically creates and manages a Cloudflare Worker with Durable Objects for state storage.


### R2 Rest State Store

Alchemy also supports state storage using Cloudflare R2, though DOStateStore is recommended for better performance:

```typescript
// Example with Cloudflare R2 state store
const app = await alchemy("my-app", {
  stage: "prod",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  stateStore: (scope) => new R2RestStateStore(scope, {
    apiKey: alchemy.secret(process.env.CLOUDFLARE_API_KEY),
    email: process.env.CLOUDFLARE_EMAIL,
    bucketName: process.env.CLOUDFLARE_BUCKET_NAME!,
  })
});
```

> [!TIP]
> Learn how to implement your own state storage in [Custom State Stores Guide](../guides/custom-state-store.md)

## Security and Secrets

State files may contain sensitive information. Alchemy provides a mechanism to encrypt sensitive values using the `alchemy.secret()` function:

```typescript
const apiKey = alchemy.secret(process.env.API_KEY);

await ApiResource("my-api", {
  key: apiKey
});
```

Secrets are encrypted in state files:

```json
{
  "props": {
    "key": {
      "@secret": "Tgz3e/WAscu4U1oanm5S4YXH..."
    }
  }
}
```

> [!IMPORTANT]
> Always use `alchemy.secret()` for sensitive values to prevent them from being stored in plain text.

> [!NOTE]
> Learn more about secrets management in [Concepts: Secrets](./secret.md)
