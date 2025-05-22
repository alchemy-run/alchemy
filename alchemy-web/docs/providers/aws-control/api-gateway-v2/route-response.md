---
title: Managing AWS ApiGatewayV2 RouteResponses with Alchemy
description: Learn how to create, update, and manage AWS ApiGatewayV2 RouteResponses using Alchemy Cloud Control.
---

# RouteResponse

The RouteResponse resource lets you create and manage [AWS ApiGatewayV2 RouteResponses](https://docs.aws.amazon.com/apigatewayv2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigatewayv2-routeresponse.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const routeresponse = await AWS.ApiGatewayV2.RouteResponse("routeresponse-example", {
  RouteResponseKey: "example-routeresponsekey",
  RouteId: "example-routeid",
  ApiId: "example-apiid",
});
```

