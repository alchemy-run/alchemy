---
order: 10
title: Resource Adoption
description: Learn how to adopt existing infrastructure with Alchemy resources. Master taking ownership of pre-existing resources instead of creating new ones.
---

# Resource Adoption

Resource adoption allows Alchemy resources to take ownership of existing infrastructure instead of failing when a resource with the same name already exists. This is particularly useful when migrating from manual infrastructure setup to Alchemy management or when resources might already exist from previous deployments.

## What is Resource Adoption?

When creating a resource, if a resource with the same name already exists in the target environment, Alchemy will normally fail with an "already exists" error. With adoption enabled, Alchemy will instead find and adopt the existing resource, bringing it under Alchemy's management.

```typescript
// Without adoption - fails if bucket already exists
const bucket = await R2Bucket("my-bucket", {
  name: "my-existing-bucket"
});

// With adoption - adopts existing bucket if it exists
const bucket = await R2Bucket("my-bucket", {
  name: "my-existing-bucket",
  adopt: true
});
```

## How Adoption Works

When `adopt: true` is set on a resource:

1. **Normal Creation**: Alchemy attempts to create the resource as usual
2. **Conflict Detection**: If the resource already exists, the provider API returns a conflict error
3. **Adoption Logic**: Instead of failing, Alchemy searches for the existing resource
4. **State Integration**: The existing resource is brought into Alchemy's state management
5. **Property Updates**: Any updatable properties are applied to the adopted resource

## Adoption Property

All Alchemy resources support the `adopt` property:

```typescript
interface ResourceProps {
  // Other properties...
  
  /**
   * Whether to adopt an existing resource if it already exists
   * If true and a resource with the same name exists, it will be adopted rather than creating a new one
   *
   * @default false
   */
  adopt?: boolean;
}
```

## Examples

### Adopting a Cloudflare R2 Bucket

```typescript
import { R2Bucket } from "alchemy/cloudflare";

// Adopt an existing R2 bucket
const bucket = await R2Bucket("storage", {
  name: "my-existing-bucket",
  adopt: true,
  allowPublicAccess: true
});

// The bucket is now managed by Alchemy
console.log(`Adopted bucket: ${bucket.name}`);
```

### Adopting a D1 Database

```typescript
import { D1Database } from "alchemy/cloudflare";

// Adopt an existing D1 database and update its configuration
const database = await D1Database("main-db", {
  name: "existing-database",
  adopt: true,
  readReplication: {
    mode: "auto"
  }
});

console.log(`Adopted database: ${database.id}`);
```

### Adopting a Cloudflare Worker

```typescript
import { Worker } from "alchemy/cloudflare";

// Adopt an existing Worker and update its script
const worker = await Worker("api", {
  name: "existing-api-worker",
  adopt: true,
  script: `
    export default {
      async fetch(request) {
        return new Response("Updated via Alchemy!");
      }
    }
  `,
  format: "esm"
});
```

### Adopting Sentry Resources

```typescript
import { Project, Team } from "alchemy/sentry";

// Adopt existing Sentry team
const team = await Team("backend-team", {
  name: "Backend Team",
  organization: "my-org",
  adopt: true
});

// Adopt existing Sentry project
const project = await Project("api-project", {
  name: "API Project",
  team: team.slug,
  organization: "my-org",
  adopt: true
});
```

## Use Cases

### Migration from Manual Setup

When transitioning from manually created infrastructure to Alchemy management:

```typescript
// Adopt existing infrastructure created outside of Alchemy
const existingBucket = await R2Bucket("assets", {
  name: "manually-created-bucket",
  adopt: true
});

const existingDatabase = await D1Database("app-db", {
  name: "manually-created-db",
  adopt: true
});
```

### Environment Consistency

Ensure resources exist across environments without failing on duplicates:

```typescript
// Safe to run multiple times - adopts if exists, creates if not
const bucket = await R2Bucket("app-storage", {
  name: `${stage}-app-storage`,
  adopt: true,
  allowPublicAccess: stage === "prod"
});
```

### Team Collaboration

When multiple team members might create the same resources:

```typescript
// Safe for multiple developers to run
const sharedResource = await KVNamespace("cache", {
  name: "shared-cache",
  adopt: true
});
```

## Adoption Behavior by Provider

### Cloudflare Resources

Cloudflare resources support adoption by catching 409 Conflict errors and searching for existing resources by name:

- **R2Bucket**: Adopts by bucket name
- **D1Database**: Adopts by database name, can update read replication settings
- **Worker**: Adopts by worker name, updates script and configuration
- **KVNamespace**: Adopts by namespace name
- **Queue**: Adopts by queue name
- **VectorizeIndex**: Adopts by index name

### AWS Resources

AWS Control resources support adoption through CloudFormation stack management:

```typescript
import { CloudControlResource } from "alchemy/aws/control";

const bucket = await CloudControlResource("s3-bucket", {
  typeName: "AWS::S3::Bucket",
  desiredState: {
    BucketName: "existing-bucket"
  },
  adopt: true
});
```

### Sentry Resources

Sentry resources support adoption by searching for existing resources by name or slug:

- **Project**: Adopts by project slug
- **Team**: Adopts by team slug  
- **ClientKey**: Adopts by key name

## Best Practices

### Use Adoption Sparingly

Only enable adoption when you specifically need to take ownership of existing resources:

```typescript
// Good: Explicit adoption for migration
const bucket = await R2Bucket("legacy-storage", {
  name: "manually-created-bucket",
  adopt: true
});

// Avoid: Adoption as default behavior
const bucket = await R2Bucket("new-storage", {
  adopt: true  // Unnecessary for new resources
});
```

### Verify Resource Properties

After adoption, verify that the adopted resource has the expected configuration:

```typescript
const database = await D1Database("main", {
  name: "existing-db",
  adopt: true,
  readReplication: { mode: "auto" }
});

// Verify the configuration was applied
console.log(`Read replication: ${database.readReplication?.mode}`);
```

### Handle Adoption Failures

Be prepared for cases where adoption might fail:

```typescript
try {
  const resource = await SomeResource("existing", {
    name: "existing-resource",
    adopt: true
  });
} catch (error) {
  if (error.message.includes("not found")) {
    console.log("Resource doesn't exist to adopt");
  } else {
    throw error;
  }
}
```

### Document Adoption Decisions

When using adoption in production code, document why it's necessary:

```typescript
// Adopting bucket created during manual migration from legacy system
const legacyBucket = await R2Bucket("legacy-assets", {
  name: "legacy-assets-bucket",
  adopt: true
});
```

## Limitations

### Provider-Specific Constraints

Not all resource properties can be updated after adoption. Check provider documentation for limitations:

- **D1Database**: Only read replication can be updated after creation
- **R2Bucket**: Location and jurisdiction cannot be changed after creation
- **Worker**: All properties can typically be updated

### Name-Based Matching

Adoption relies on name-based matching, which may not be suitable for all scenarios:

```typescript
// Adoption finds resources by name, not by other identifiers
const bucket = await R2Bucket("storage", {
  name: "exact-bucket-name",  // Must match exactly
  adopt: true
});
```

### State Consistency

Adopted resources must be compatible with Alchemy's state management expectations.

## Error Handling

Resources handle adoption errors gracefully:

```typescript
// If adoption fails, the original error is thrown
try {
  const resource = await Resource("id", {
    name: "existing-resource",
    adopt: true
  });
} catch (error) {
  // Could be "already exists" error if adoption failed
  // Or "not found" error if resource doesn't exist to adopt
  console.error("Adoption failed:", error.message);
}
```

## Related Concepts

- **[Resource](./resource.md)**: Learn about resource lifecycle and management
- **[State](./state.md)**: Understand how Alchemy tracks resource state
- **[Scope](./scope.md)**: Organize resources within hierarchical scopes
