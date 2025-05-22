---
title: Managing AWS IoT Authorizers with Alchemy
description: Learn how to create, update, and manage AWS IoT Authorizers using Alchemy Cloud Control.
---

# Authorizer

The Authorizer resource lets you create and manage [AWS IoT Authorizers](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-authorizer.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const authorizer = await AWS.IoT.Authorizer("authorizer-example", {
  AuthorizerFunctionArn: "example-authorizerfunctionarn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a authorizer with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAuthorizer = await AWS.IoT.Authorizer("advanced-authorizer", {
  AuthorizerFunctionArn: "example-authorizerfunctionarn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

