---
title: Managing AWS Cognito IdentityPoolPrincipalTags with Alchemy
description: Learn how to create, update, and manage AWS Cognito IdentityPoolPrincipalTags using Alchemy Cloud Control.
---

# IdentityPoolPrincipalTag

The IdentityPoolPrincipalTag resource lets you create and manage [AWS Cognito IdentityPoolPrincipalTags](https://docs.aws.amazon.com/cognito/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-identitypoolprincipaltag.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const identitypoolprincipaltag = await AWS.Cognito.IdentityPoolPrincipalTag(
  "identitypoolprincipaltag-example",
  {
    IdentityProviderName: "identitypoolprincipaltag-identityprovider",
    IdentityPoolId: "example-identitypoolid",
  }
);
```

