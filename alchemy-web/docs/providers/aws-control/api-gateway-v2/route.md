---
title: Managing AWS ApiGatewayV2 Routes with Alchemy
description: Learn how to create, update, and manage AWS ApiGatewayV2 Routes using Alchemy Cloud Control.
---

# Route

The Route resource lets you create and manage [AWS ApiGatewayV2 Routes](https://docs.aws.amazon.com/apigatewayv2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigatewayv2-route.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const route = await AWS.ApiGatewayV2.Route("route-example", {
  RouteKey: "example-routekey",
  ApiId: "example-apiid",
});
```

