---
title: Managing AWS Organizations Policys with Alchemy
description: Learn how to create, update, and manage AWS Organizations Policys using Alchemy Cloud Control.
---

# Policy

The Policy resource lets you create and manage [AWS Organizations Policys](https://docs.aws.amazon.com/organizations/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-organizations-policy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const policy = await AWS.Organizations.Policy("policy-example", {
  Type: "example-type",
  Content: {},
  Name: "policy-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A policy resource managed by Alchemy",
});
```

## Advanced Configuration

Create a policy with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPolicy = await AWS.Organizations.Policy("advanced-policy", {
  Type: "example-type",
  Content: {},
  Name: "policy-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A policy resource managed by Alchemy",
});
```

