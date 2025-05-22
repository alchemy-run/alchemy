---
title: Managing AWS Bedrock Blueprints with Alchemy
description: Learn how to create, update, and manage AWS Bedrock Blueprints using Alchemy Cloud Control.
---

# Blueprint

The Blueprint resource lets you create and manage [AWS Bedrock Blueprints](https://docs.aws.amazon.com/bedrock/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-bedrock-blueprint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const blueprint = await AWS.Bedrock.Blueprint("blueprint-example", {
  Type: "example-type",
  BlueprintName: "blueprint-blueprint",
  Schema: {},
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a blueprint with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedBlueprint = await AWS.Bedrock.Blueprint("advanced-blueprint", {
  Type: "example-type",
  BlueprintName: "blueprint-blueprint",
  Schema: {},
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

