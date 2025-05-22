---
title: Managing AWS IAM ManagedPolicys with Alchemy
description: Learn how to create, update, and manage AWS IAM ManagedPolicys using Alchemy Cloud Control.
---

# ManagedPolicy

The ManagedPolicy resource lets you create and manage [AWS IAM ManagedPolicys](https://docs.aws.amazon.com/iam/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-managedpolicy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const managedpolicy = await AWS.IAM.ManagedPolicy("managedpolicy-example", {
  PolicyDocument: {},
  Description: "A managedpolicy resource managed by Alchemy",
});
```

## Advanced Configuration

Create a managedpolicy with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedManagedPolicy = await AWS.IAM.ManagedPolicy("advanced-managedpolicy", {
  PolicyDocument: {},
  Description: "A managedpolicy resource managed by Alchemy",
});
```

