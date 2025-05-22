---
title: Managing AWS Cognito IdentityPools with Alchemy
description: Learn how to create, update, and manage AWS Cognito IdentityPools using Alchemy Cloud Control.
---

# IdentityPool

The IdentityPool resource lets you create and manage [AWS Cognito IdentityPools](https://docs.aws.amazon.com/cognito/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-identitypool.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const identitypool = await AWS.Cognito.IdentityPool("identitypool-example", {
  AllowUnauthenticatedIdentities: true,
});
```

