# Scope

Scope is a fundamental concept in Alchemy that manages the lifecycle and organization of resources. Scopes form a hierarchical structure that determines how resources are created, updated, and deleted, as well as how state is stored and managed.

## The Application Scope

The Application Scope is the root scope that serves as the entry point for your Alchemy application. It establishes the foundation for all resources and child scopes.

```typescript
// Create the root application scope
const app = await alchemy("my-app");
```

> [!NOTE]
> The Application Scope creates a directory structure in `.alchemy/my-app/` to store state for all resources created within this scope.

## The Stage Scope

When you create an Application, a child Stage scope is created by default. This provides environment isolation for your resources.

```typescript
const dev = await alchemy("my-app", {
  stage: "dev" // Defaults to $USER if not specified
});
```

> [!TIP]
> Using different stages like "dev", "staging", and "prod" allows you to maintain separate environments with identical resource structures but different configurations.

## Nested Scopes

You can create nested scopes to isolate resources and organize them logically. Resources created within a nested scope are automatically managed together.

```typescript
await alchemy.run("nested-scope", async (scope) => {
  // Resources created here are part of the nested scope
});
```

## Resource Scopes

Each Resource has its own Scope that manages its lifecycle and dependencies. When a resource creates other resources during its lifecycle, those resources are scoped to the parent resource.

## Scope Finalization

Finalization is a critical phase in the Scope lifecycle that ensures all resources are properly created and orphaned resources are identified for cleanup.

```typescript
// Finalize the scope to ensure all resources are created
await scope.finalize();
```

> [!NOTE]
> Finalization is automatically triggered when using `await using` with a scope or when the `alchemy.run()` function completes.

## Destroying Scopes

When a scope is destroyed, all resources within that scope are also destroyed in the correct dependency order.

```typescript
await alchemy.destroy(scope);
```

## Orphaned Resources

After scope finalization, Alchemy detects any resources that are no longer referenced by any scope and marks them for cleanup. This automatic garbage collection ensures that resources don't remain when they're no longer needed.

## Scope State

Scope state is stored in the `.alchemy` folder in your project, organized by application name, stage, and scope hierarchy. This state tracks the current status of all resources and enables Alchemy to determine when resources need to be created, updated, or deleted.

> [!TIP]
> You can inspect the state files in `.alchemy/` to understand the current state of your resources and troubleshoot issues.