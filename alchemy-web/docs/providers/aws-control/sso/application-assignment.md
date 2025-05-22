---
title: Managing AWS SSO ApplicationAssignments with Alchemy
description: Learn how to create, update, and manage AWS SSO ApplicationAssignments using Alchemy Cloud Control.
---

# ApplicationAssignment

The ApplicationAssignment resource lets you create and manage [AWS SSO ApplicationAssignments](https://docs.aws.amazon.com/sso/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sso-applicationassignment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const applicationassignment = await AWS.SSO.ApplicationAssignment("applicationassignment-example", {
  ApplicationArn: "example-applicationarn",
  PrincipalId: "example-principalid",
  PrincipalType: "example-principaltype",
});
```

