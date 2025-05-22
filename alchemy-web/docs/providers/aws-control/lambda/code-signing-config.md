---
title: Managing AWS Lambda CodeSigningConfigs with Alchemy
description: Learn how to create, update, and manage AWS Lambda CodeSigningConfigs using Alchemy Cloud Control.
---

# CodeSigningConfig

The CodeSigningConfig resource lets you create and manage [AWS Lambda CodeSigningConfigs](https://docs.aws.amazon.com/lambda/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-codesigningconfig.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const codesigningconfig = await AWS.Lambda.CodeSigningConfig("codesigningconfig-example", {
  AllowedPublishers: "example-allowedpublishers",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A codesigningconfig resource managed by Alchemy",
});
```

## Advanced Configuration

Create a codesigningconfig with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCodeSigningConfig = await AWS.Lambda.CodeSigningConfig("advanced-codesigningconfig", {
  AllowedPublishers: "example-allowedpublishers",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A codesigningconfig resource managed by Alchemy",
});
```

