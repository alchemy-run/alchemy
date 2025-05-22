---
title: Managing AWS Cognito IdentityPoolRoleAttachments with Alchemy
description: Learn how to create, update, and manage AWS Cognito IdentityPoolRoleAttachments using Alchemy Cloud Control.
---

# IdentityPoolRoleAttachment

The IdentityPoolRoleAttachment resource lets you create and manage [AWS Cognito IdentityPoolRoleAttachments](https://docs.aws.amazon.com/cognito/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-identitypoolroleattachment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const identitypoolroleattachment = await AWS.Cognito.IdentityPoolRoleAttachment(
  "identitypoolroleattachment-example",
  { IdentityPoolId: "example-identitypoolid" }
);
```

