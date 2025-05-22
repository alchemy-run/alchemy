---
title: Managing AWS Cognito UserPoolUserToGroupAttachments with Alchemy
description: Learn how to create, update, and manage AWS Cognito UserPoolUserToGroupAttachments using Alchemy Cloud Control.
---

# UserPoolUserToGroupAttachment

The UserPoolUserToGroupAttachment resource lets you create and manage [AWS Cognito UserPoolUserToGroupAttachments](https://docs.aws.amazon.com/cognito/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpoolusertogroupattachment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const userpoolusertogroupattachment = await AWS.Cognito.UserPoolUserToGroupAttachment(
  "userpoolusertogroupattachment-example",
  {
    GroupName: "userpoolusertogroupattachment-group",
    UserPoolId: "example-userpoolid",
    Username: "userpoolusertogroupattachment-user",
  }
);
```

