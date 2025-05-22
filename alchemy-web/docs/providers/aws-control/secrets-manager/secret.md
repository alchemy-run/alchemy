---
title: Managing AWS SecretsManager Secrets with Alchemy
description: Learn how to create, update, and manage AWS SecretsManager Secrets using Alchemy Cloud Control.
---

# Secret

The Secret resource lets you create and manage [AWS SecretsManager Secrets](https://docs.aws.amazon.com/secretsmanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-secretsmanager-secret.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const secret = await AWS.SecretsManager.Secret("secret-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A secret resource managed by Alchemy",
});
```

## Advanced Configuration

Create a secret with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSecret = await AWS.SecretsManager.Secret("advanced-secret", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A secret resource managed by Alchemy",
});
```

