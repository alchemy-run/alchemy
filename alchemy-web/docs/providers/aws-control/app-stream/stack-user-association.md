---
title: Managing AWS AppStream StackUserAssociations with Alchemy
description: Learn how to create, update, and manage AWS AppStream StackUserAssociations using Alchemy Cloud Control.
---

# StackUserAssociation

The StackUserAssociation resource lets you create and manage [AWS AppStream StackUserAssociations](https://docs.aws.amazon.com/appstream/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appstream-stackuserassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const stackuserassociation = await AWS.AppStream.StackUserAssociation(
  "stackuserassociation-example",
  {
    UserName: "stackuserassociation-user",
    StackName: "stackuserassociation-stack",
    AuthenticationType: "example-authenticationtype",
  }
);
```

