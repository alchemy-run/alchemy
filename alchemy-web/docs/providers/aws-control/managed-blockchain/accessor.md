---
title: Managing AWS ManagedBlockchain Accessors with Alchemy
description: Learn how to create, update, and manage AWS ManagedBlockchain Accessors using Alchemy Cloud Control.
---

# Accessor

The Accessor resource lets you create and manage [AWS ManagedBlockchain Accessors](https://docs.aws.amazon.com/managedblockchain/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-managedblockchain-accessor.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const accessor = await AWS.ManagedBlockchain.Accessor("accessor-example", {
  AccessorType: "example-accessortype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a accessor with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAccessor = await AWS.ManagedBlockchain.Accessor("advanced-accessor", {
  AccessorType: "example-accessortype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

