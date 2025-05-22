---
title: Managing AWS ApiGatewayV2 Apis with Alchemy
description: Learn how to create, update, and manage AWS ApiGatewayV2 Apis using Alchemy Cloud Control.
---

# Api

The Api resource lets you create and manage [AWS ApiGatewayV2 Apis](https://docs.aws.amazon.com/apigatewayv2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigatewayv2-api.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const api = await AWS.ApiGatewayV2.Api("api-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A api resource managed by Alchemy",
});
```

## Advanced Configuration

Create a api with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApi = await AWS.ApiGatewayV2.Api("advanced-api", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A api resource managed by Alchemy",
});
```

