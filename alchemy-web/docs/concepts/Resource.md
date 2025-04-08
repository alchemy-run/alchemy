---
order: 1
---

# Resource

Resources are the core building blocks of Alchemy. Each resource represents a piece of infrastructure or configuration that can be created, updated, and deleted automatically.

## What is a Resource?

In Alchemy, a resource is:

1. **A memoized async function** that can run in any JavaScript environment
2. **Stateful** with tracked inputs and outputs
3. **Lifecycle-aware** with create, update, and delete phases
4. **Dependency-aware** with automatic dependency resolution

## Resource Structure

Each Alchemy resource follows a consistent pattern:

```typescript
// Props interface for resource inputs
export interface ResourceNameProps {
  // Required and optional properties for creating/updating
  name: string;
  description?: string;
}

// Resource interface for outputs (extends the props)
export interface ResourceName extends Resource<"service::ResourceName">, ResourceNameProps {
  // Additional properties returned after creation
  id: string;
  createdAt: number;
}

// Resource implementation
export const ResourceName = Resource(
  "service::ResourceName",
  async function(this: Context<ResourceName>, id: string, props: ResourceNameProps): Promise<ResourceName> {
    // Implementation of create/update/delete lifecycle
    if (this.phase === "delete") {
      // Delete the resource
      return this.destroy();
    } else {
      // Create or update the resource
      return this({
        id: "generated-id",
        ...props,
        createdAt: Date.now()
      });
    }
  }
);
```

## Resource Usage

Using a resource is as simple as calling an async function:

```typescript
// Create a new resource instance
const myResource = await ResourceName("my-resource", {
  name: "My Resource",
  description: "This is a test resource"
});

// Access resource outputs
console.log(myResource.id); // "generated-id"
console.log(myResource.name); // "My Resource"
```

## Resource Context

Each resource has access to a special `this` context that provides:

- `this.phase`: Current lifecycle phase ("create", "update", or "delete")
- `this.output`: Current resource state (previous outputs)
- `this({...})`: Constructor for returning resource outputs
- `this.destroy()`: Helper for resource deletion

## Resource Lifecycle

Alchemy resources go through three main lifecycle phases:

1. **Create**: When a resource is first created
2. **Update**: When a resource's properties change
3. **Delete**: When a resource is removed or orphaned

The appropriate phase is determined by comparing current inputs with stored state.

> [!NOTE]
> When resources are removed from code but still exist in state, they become "orphaned".

## Custom Resources

Creating custom resources is straightforward:

```typescript
export const MyCustomResource = Resource(
  "custom::MyResource",
  async function(this, id, props) {
    // Your implementation here
    return this({
      id: "my-id",
      ...props
    });
  }
);
```

This pattern makes Alchemy highly extensible, allowing you to easily implement your own resources for any service.

## Resource Scopes

Resources can be organized into scopes:

```typescript
await alchemy.run("api", async () => {
  // Resources created here are in the "api" scope
  await Table("users");
  await Function("getUser");
});
```

Scopes create a tree structure that helps with organization and dependency management.

> [!TIP]
> Learn more about scopes in [Concepts: Scope](./scope.md)

## Related Concepts

- [State Management](./state.md)
- [Resource Destroy](./destroy.md)
- [Secrets](./secret.md) 
- [Scopes](./scope.md)