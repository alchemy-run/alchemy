---
title: Managing AWS IoT Policys with Alchemy
description: Learn how to create, update, and manage AWS IoT Policys using Alchemy Cloud Control.
---

# Policy

The Policy resource lets you create and manage [AWS IoT Policys](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-policy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const policy = await AWS.IoT.Policy("policy-example", {
  PolicyDocument: {},
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a policy with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPolicy = await AWS.IoT.Policy("advanced-policy", {
  PolicyDocument: {},
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

