---
title: Managing AWS ApiGatewayV2 Authorizers with Alchemy
description: Learn how to create, update, and manage AWS ApiGatewayV2 Authorizers using Alchemy Cloud Control.
---

# Authorizer

The Authorizer resource lets you create and manage [AWS ApiGatewayV2 Authorizers](https://docs.aws.amazon.com/apigatewayv2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigatewayv2-authorizer.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const authorizer = await AWS.ApiGatewayV2.Authorizer("authorizer-example", {
  AuthorizerType: "example-authorizertype",
  ApiId: "example-apiid",
  Name: "authorizer-",
});
```

