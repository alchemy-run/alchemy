# State Management in Alchemy

Alchemy uses a state management system to track resources and their dependencies across scopes. The state system is responsible for determining when to create, update, delete, or skip resources during execution.

## What is State in Alchemy?

State in Alchemy represents the persisted information about resources that have been created. It contains the resource's properties, outputs, and metadata needed to manage the resource lifecycle.

> [!NOTE]
> State is what enables Alchemy to be idempotent - running the same code multiple times will only create resources once.

## State and Resource Lifecycle

State directly influences how resources are processed:

1. No state → Resource is created
2. State exists, inputs unchanged → Resource is skipped
3. State exists, inputs changed → Resource is updated
4. State exists, resource no longer in code → Resource is deleted

> [!TIP]
> You can inspect state files to understand what resources exist and their current configuration.

# The State Store Interface

The state store interface is designed to be storage-agnostic, supporting multiple backends through a common API. This allows Alchemy to work with various storage options:

- Local filesystem (.alchemy folder)
- Cloud storage (S3, R2)
- Databases (DynamoDB, SQLite)
- Other key-value stores

Each state store implements methods for listing, getting, setting, and deleting state entries.

# Default State Storage

By default, state is stored in the `.alchemy` folder in your project directory. The structure follows a hierarchical pattern based on scopes:

```
.alchemy/
  my-app/                 # Application scope
    prod/                 # Stage scope
      my-resource.json    # Resource state
      nested-scope/       # Nested scope
        other-resource.json
```

# State File Format

State files are stored as JSON and contain all the information needed to manage a resource:

```json
{
  "status": "updated",
  "kind": "cloudflare::Worker",
  "id": "api",
  "fqn": "my-app/prod/api",
  "seq": 3,
  "data": {},
  "props": {
    "name": "my-worker",
    "entrypoint": "./src/index.ts",
    "bindings": {
      "KV_NAMESPACE": {
        "namespaceId": "abcdef123456",
        "title": "my-namespace"
      }
    }
  },
  "output": {
    "id": "api",
    "name": "my-worker",
    "url": "https://my-worker.workers.dev",
    "createdAt": 1678901234567
  }
}
```

> [!NOTE]
> Sensitive values like API keys are automatically encrypted when using the `alchemy.secret()` function and a password is provided.

# Override the Application State Store

The state store is pluggable and can be overridden when initializing your application:

```javascript
import { R2RestStateStore } from "alchemy/cloudflare";

const app = alchemy("my-app", {
  state: new R2RestStateStore({
    bucket: "my-bucket",
    accessKeyId: "my-access-key-id",
    secretAccessKey: "my-secret-access-key",
  })
});
```

# Override a Scope's Application State Store

You can also configure a different state store for a specific scope:

```javascript
await alchemy.run("my-app", {
  stateStore: new R2StateStore({
    bucket: "my-bucket",
    accessKeyId: "my-access-key-id",
    secretAccessKey: "my-secret-access-key",
  })
}, async (scope) => {
    // Resources created here will use the R2 state store
})
```

> [!NOTE]
> Nested scopes inherit the state store of their parent scope (unless otherwise specified)