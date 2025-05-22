---
title: Managing AWS Lambda Permissions with Alchemy
description: Learn how to create, update, and manage AWS Lambda Permissions using Alchemy Cloud Control.
---

# Permission

The Permission resource lets you create and manage [AWS Lambda Permissions](https://docs.aws.amazon.com/lambda/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-permission.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const permission = await AWS.Lambda.Permission("permission-example", {
  FunctionName: "permission-function",
  Action: "example-action",
  Principal: "example-principal",
});
```

