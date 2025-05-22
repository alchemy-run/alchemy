---
title: Managing AWS Glue Registrys with Alchemy
description: Learn how to create, update, and manage AWS Glue Registrys using Alchemy Cloud Control.
---

# Registry

The Registry resource lets you create and manage [AWS Glue Registrys](https://docs.aws.amazon.com/glue/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-glue-registry.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const registry = await AWS.Glue.Registry("registry-example", {
  Name: "registry-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A registry resource managed by Alchemy",
});
```

## Advanced Configuration

Create a registry with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRegistry = await AWS.Glue.Registry("advanced-registry", {
  Name: "registry-",
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

