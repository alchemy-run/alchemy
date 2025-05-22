---
title: Managing AWS Lambda LayerVersionPermissions with Alchemy
description: Learn how to create, update, and manage AWS Lambda LayerVersionPermissions using Alchemy Cloud Control.
---

# LayerVersionPermission

The LayerVersionPermission resource lets you create and manage [AWS Lambda LayerVersionPermissions](https://docs.aws.amazon.com/lambda/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-layerversionpermission.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const layerversionpermission = await AWS.Lambda.LayerVersionPermission(
  "layerversionpermission-example",
  {
    Action: "example-action",
    LayerVersionArn: "example-layerversionarn",
    Principal: "example-principal",
  }
);
```

