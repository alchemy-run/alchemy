---
title: Managing AWS ApiGateway GatewayResponses with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway GatewayResponses using Alchemy Cloud Control.
---

# GatewayResponse

The GatewayResponse resource lets you create and manage [AWS ApiGateway GatewayResponses](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-gatewayresponse.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const gatewayresponse = await AWS.ApiGateway.GatewayResponse("gatewayresponse-example", {
  RestApiId: "example-restapiid",
  ResponseType: "example-responsetype",
});
```

