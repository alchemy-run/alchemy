---
title: Managing AWS SSO Assignments with Alchemy
description: Learn how to create, update, and manage AWS SSO Assignments using Alchemy Cloud Control.
---

# Assignment

The Assignment resource lets you create and manage [AWS SSO Assignments](https://docs.aws.amazon.com/sso/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sso-assignment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const assignment = await AWS.SSO.Assignment("assignment-example", {
  PrincipalId: "example-principalid",
  InstanceArn: "example-instancearn",
  TargetType: "example-targettype",
  PermissionSetArn: "example-permissionsetarn",
  PrincipalType: "example-principaltype",
  TargetId: "example-targetid",
});
```

