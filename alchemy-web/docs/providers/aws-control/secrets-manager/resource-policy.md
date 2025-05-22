---
title: Managing AWS SecretsManager ResourcePolicys with Alchemy
description: Learn how to create, update, and manage AWS SecretsManager ResourcePolicys using Alchemy Cloud Control.
---

# ResourcePolicy

The ResourcePolicy resource lets you create and manage [AWS SecretsManager ResourcePolicys](https://docs.aws.amazon.com/secretsmanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-secretsmanager-resourcepolicy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resourcepolicy = await AWS.SecretsManager.ResourcePolicy("resourcepolicy-example", {
  SecretId: "example-secretid",
  ResourcePolicy: {},
});
```

