# Resource

A Resource in Alchemy is a fundamental building block that represents an infrastructure component with a lifecycle of creation, updating, and deletion. Resources are implemented as memoized async functions that can be executed in any JavaScript environment.

## How to create a Resource

Creating a resource is as simple as awaiting a resource function with an ID and properties:

```typescript
await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/index.ts",
  bindings: {
    COUNTER: counter,
    STORAGE: storage
  }
});
```

> [!NOTE]
> The first parameter is the resource ID which must be unique within the current scope.

## How to update a Resource

Updating a resource uses the same syntax as creating one - Alchemy automatically detects changes to the properties and performs an update operation:

```typescript
await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/index.ts",
  bindings: {
    COUNTER: counter,
    STORAGE: storage,
    NEW_BINDING: newBinding
  }
});
```

## What is a Resource Provider

A Resource Provider is the implementation of a specific resource type that handles its lifecycle operations. It defines how a resource is created, updated, and deleted.

```typescript
interface MyResourceProps { }
interface MyResource extends Resource<"my::resource"> { }

const MyResource = Resource(
    "my::resource", 
    async function(this: Context<MyResource>, props: MyResourceProps) {
        if (this.phase === "delete") {
            return this.destroy();
        } else if (this.phase === "create") {
            // create resource implementation
        } else if (this.phase === "update") {
            // update resource implementation
        }
        return this({});
    }
);
```

> [!TIP]
> Resource providers follow a "pseudo-class" pattern where `this` is bound to the resource context, providing access to the current phase, state, and helper methods.

## The CRUD lifecycle

Resources in Alchemy follow a Create, Read, Update, Delete (CRUD) lifecycle. When a resource is first created, it enters the "create" phase. When properties change, it enters the "update" phase. When a resource is no longer referenced in code or explicitly destroyed, it enters the "delete" phase.

## State

Each resource maintains its state in a JSON file that tracks the resource's properties, outputs, and metadata. This state is used to determine whether a resource needs to be created, updated, or deleted.

> [!NOTE]
> For more information on state management, see /docs/concepts/state

## Resource Scope

Each Resource has its own Scope which isolates any resources created within its lifecycle handler.

> [!NOTE]
> For more information on scopes, see /docs/concepts/scope

A resource provider can create other resources within its implementation:

```typescript
const ComplexResource = Resource(
    "my::complex", 
    async function(this: Context<ComplexResource>, props: ComplexResourceProps) {
        // Create dependent resources within this resource's scope
        const storage = await R2Bucket("storage", {
            name: "resource-storage"
        });
        
        const worker = await Worker("worker", {
            name: "resource-worker",
            bindings: {
                STORAGE: storage
            }
        });
        
        return this({
            storageId: storage.id,
            workerId: worker.id
        });
    }
);
```