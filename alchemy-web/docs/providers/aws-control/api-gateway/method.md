---
title: Managing AWS ApiGateway Methods with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway Methods using Alchemy Cloud Control.
---

# Method

The Method resource lets you create and manage [AWS ApiGateway Methods](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-method.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const method = await AWS.ApiGateway.Method("method-example", {
  RestApiId: "example-restapiid",
  ResourceId: "example-resourceid",
  HttpMethod: "example-httpmethod",
});
```

