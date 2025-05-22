---
title: Managing AWS Lambda Urls with Alchemy
description: Learn how to create, update, and manage AWS Lambda Urls using Alchemy Cloud Control.
---

# Url

The Url resource lets you create and manage [AWS Lambda Urls](https://docs.aws.amazon.com/lambda/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-url.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const url = await AWS.Lambda.Url("url-example", {
  AuthType: "example-authtype",
  TargetFunctionArn: "example-targetfunctionarn",
});
```

