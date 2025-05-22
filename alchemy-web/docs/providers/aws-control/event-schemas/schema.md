---
title: Managing AWS EventSchemas Schemas with Alchemy
description: Learn how to create, update, and manage AWS EventSchemas Schemas using Alchemy Cloud Control.
---

# Schema

The Schema resource lets you create and manage [AWS EventSchemas Schemas](https://docs.aws.amazon.com/eventschemas/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-eventschemas-schema.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const schema = await AWS.EventSchemas.Schema("schema-example", {
  Type: "example-type",
  Content: "example-content",
  RegistryName: "schema-registry",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A schema resource managed by Alchemy",
});
```

## Advanced Configuration

Create a schema with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSchema = await AWS.EventSchemas.Schema("advanced-schema", {
  Type: "example-type",
  Content: "example-content",
  RegistryName: "schema-registry",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A schema resource managed by Alchemy",
});
```

