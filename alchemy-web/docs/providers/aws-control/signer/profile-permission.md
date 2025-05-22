---
title: Managing AWS Signer ProfilePermissions with Alchemy
description: Learn how to create, update, and manage AWS Signer ProfilePermissions using Alchemy Cloud Control.
---

# ProfilePermission

The ProfilePermission resource lets you create and manage [AWS Signer ProfilePermissions](https://docs.aws.amazon.com/signer/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-signer-profilepermission.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const profilepermission = await AWS.Signer.ProfilePermission("profilepermission-example", {
  Action: "example-action",
  StatementId: "example-statementid",
  ProfileName: "profilepermission-profile",
  Principal: "example-principal",
});
```

