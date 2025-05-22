---
title: Managing AWS ApiGateway Stages with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway Stages using Alchemy Cloud Control.
---

# Stage

The Stage resource lets you create and manage [AWS ApiGateway Stages](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-stage.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const stage = await AWS.ApiGateway.Stage("stage-example", {
  RestApiId: "example-restapiid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A stage resource managed by Alchemy",
});
```

## Advanced Configuration

Create a stage with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedStage = await AWS.ApiGateway.Stage("advanced-stage", {
  RestApiId: "example-restapiid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A stage resource managed by Alchemy",
});
```

