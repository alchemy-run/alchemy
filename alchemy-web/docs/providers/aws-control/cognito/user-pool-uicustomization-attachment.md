---
title: Managing AWS Cognito UserPoolUICustomizationAttachments with Alchemy
description: Learn how to create, update, and manage AWS Cognito UserPoolUICustomizationAttachments using Alchemy Cloud Control.
---

# UserPoolUICustomizationAttachment

The UserPoolUICustomizationAttachment resource lets you create and manage [AWS Cognito UserPoolUICustomizationAttachments](https://docs.aws.amazon.com/cognito/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cognito-userpooluicustomizationattachment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const userpooluicustomizationattachment = await AWS.Cognito.UserPoolUICustomizationAttachment(
  "userpooluicustomizationattachment-example",
  { UserPoolId: "example-userpoolid", ClientId: "example-clientid" }
);
```

