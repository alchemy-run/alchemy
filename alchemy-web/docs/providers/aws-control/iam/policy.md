---
title: Managing AWS IAM Policys with Alchemy
description: Learn how to create, update, and manage AWS IAM Policys using Alchemy Cloud Control.
---

# Policy

The Policy resource lets you create and manage [AWS IAM Policys](https://docs.aws.amazon.com/iam/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-policy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const policy = await AWS.IAM.Policy("policy-example", {
  PolicyName: "policy-policy",
  PolicyDocument: {},
});
```

