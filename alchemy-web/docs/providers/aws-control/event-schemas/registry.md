---
title: Managing AWS EventSchemas Registrys with Alchemy
description: Learn how to create, update, and manage AWS EventSchemas Registrys using Alchemy Cloud Control.
---

# Registry

The Registry resource lets you create and manage [AWS EventSchemas Registrys](https://docs.aws.amazon.com/eventschemas/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-eventschemas-registry.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const registry = await AWS.EventSchemas.Registry("registry-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A registry resource managed by Alchemy",
});
```

## Advanced Configuration

Create a registry with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRegistry = await AWS.EventSchemas.Registry("advanced-registry", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A registry resource managed by Alchemy",
});
```

