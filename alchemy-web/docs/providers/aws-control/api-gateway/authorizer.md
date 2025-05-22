---
title: Managing AWS ApiGateway Authorizers with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway Authorizers using Alchemy Cloud Control.
---

# Authorizer

The Authorizer resource lets you create and manage [AWS ApiGateway Authorizers](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-authorizer.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const authorizer = await AWS.ApiGateway.Authorizer("authorizer-example", {
  Type: "example-type",
  RestApiId: "example-restapiid",
  Name: "authorizer-",
});
```

