---
title: Managing AWS Glue CustomEntityTypes with Alchemy
description: Learn how to create, update, and manage AWS Glue CustomEntityTypes using Alchemy Cloud Control.
---

# CustomEntityType

The CustomEntityType resource lets you create and manage [AWS Glue CustomEntityTypes](https://docs.aws.amazon.com/glue/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-glue-customentitytype.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const customentitytype = await AWS.Glue.CustomEntityType("customentitytype-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a customentitytype with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCustomEntityType = await AWS.Glue.CustomEntityType("advanced-customentitytype", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

