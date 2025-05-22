---
title: Managing AWS Cognito UserPoolClients with Alchemy
description: Learn how to create, update, and manage AWS Cognito UserPoolClients using Alchemy Cloud Control.
---

# UserPoolClient

The UserPoolClient resource lets you create and manage [AWS Cognito UserPoolClients](https://docs.aws.amazon.com/cognito/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpoolclient.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const userpoolclient = await AWS.Cognito.UserPoolClient("userpoolclient-example", {
  UserPoolId: "example-userpoolid",
});
```

