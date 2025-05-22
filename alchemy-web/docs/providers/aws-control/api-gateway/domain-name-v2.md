---
title: Managing AWS ApiGateway DomainNameV2s with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway DomainNameV2s using Alchemy Cloud Control.
---

# DomainNameV2

The DomainNameV2 resource lets you create and manage [AWS ApiGateway DomainNameV2s](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-domainnamev2.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const domainnamev2 = await AWS.ApiGateway.DomainNameV2("domainnamev2-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a domainnamev2 with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDomainNameV2 = await AWS.ApiGateway.DomainNameV2("advanced-domainnamev2", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Policy: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }],
  },
});
```

