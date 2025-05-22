---
title: Managing AWS ApiGateway ApiKeys with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway ApiKeys using Alchemy Cloud Control.
---

# ApiKey

The ApiKey resource lets you create and manage [AWS ApiGateway ApiKeys](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-apikey.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const apikey = await AWS.ApiGateway.ApiKey("apikey-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A apikey resource managed by Alchemy",
});
```

## Advanced Configuration

Create a apikey with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApiKey = await AWS.ApiGateway.ApiKey("advanced-apikey", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A apikey resource managed by Alchemy",
});
```

