---
title: Managing AWS Cognito UserPoolUsers with Alchemy
description: Learn how to create, update, and manage AWS Cognito UserPoolUsers using Alchemy Cloud Control.
---

# UserPoolUser

The UserPoolUser resource lets you create and manage [AWS Cognito UserPoolUsers](https://docs.aws.amazon.com/cognito/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpooluser.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const userpooluser = await AWS.Cognito.UserPoolUser("userpooluser-example", {
  UserPoolId: "example-userpoolid",
});
```

