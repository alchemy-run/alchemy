---
title: Managing AWS IAM OIDCProviders with Alchemy
description: Learn how to create, update, and manage AWS IAM OIDCProviders using Alchemy Cloud Control.
---

# OIDCProvider

The OIDCProvider resource lets you create and manage [AWS IAM OIDCProviders](https://docs.aws.amazon.com/iam/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-oidcprovider.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const oidcprovider = await AWS.IAM.OIDCProvider("oidcprovider-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a oidcprovider with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedOIDCProvider = await AWS.IAM.OIDCProvider("advanced-oidcprovider", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

