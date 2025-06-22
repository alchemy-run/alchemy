---
order: 10
title: Replace
description: Learn how to safely replace infrastructure resources with Alchemy. Understand the risks and best practices for resource replacement.
---
# Replace

Resource replacement in Alchemy recreates and deletes resources that can **not**
be updated, both in your state file and in the underlying infrastructure. The
deletion of the old resource is scheduled and will occur after the new resource
is created.

## Basic Usage
During the **update phase**, call `this.replace()` when a change requires
resource replacement:

```typescript
// Implementation pattern
if (this.phase === "update") {
  if (this.output.name !== props.name) {
    this.replace();
  }
}
```
Use inside a handler to tell alchemy a resource needs to be replaced

## How It Works

During the **update phase**, if a resource calls `this.replace()`, alchemy will create a new resource and schedule the old resource for deletion. The scheduled deletion will occur when the root scope is finalized.

## Forcing Deletion Early

Deletion of the old resource can be forced by passing `true` to the `scope.finalize` method. Forcing early deletion will still wait for the new resource to be created.

```typescript
await scope.finalize(true);
```

## Errors in Deletion

If an error occurs during deletion, the scope will be finalized and alchemy will attempt to destroy the old resource again during the next finalization process.

## Replacing Resources with Children

Resources with children cannot be replaced, this will result in an error being
thrown during finalization.

## Related Concepts

- **[Destroy](./destroy.md)** - How to destroy resources
- **[Scope](./scope.md)** - Scope lifecycle
