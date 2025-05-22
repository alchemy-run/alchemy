---
title: Managing AWS ApiGateway RestApis with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway RestApis using Alchemy Cloud Control.
---

# RestApi

The RestApi resource lets you create and manage [AWS ApiGateway RestApis](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-restapi.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const restapi = await AWS.ApiGateway.RestApi("restapi-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A restapi resource managed by Alchemy",
});
```

## Advanced Configuration

Create a restapi with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRestApi = await AWS.ApiGateway.RestApi("advanced-restapi", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A restapi resource managed by Alchemy",
  Policy: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }],
  },
});
```

