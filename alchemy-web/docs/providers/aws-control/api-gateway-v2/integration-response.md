---
title: Managing AWS ApiGatewayV2 IntegrationResponses with Alchemy
description: Learn how to create, update, and manage AWS ApiGatewayV2 IntegrationResponses using Alchemy Cloud Control.
---

# IntegrationResponse

The IntegrationResponse resource lets you create and manage [AWS ApiGatewayV2 IntegrationResponses](https://docs.aws.amazon.com/apigatewayv2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigatewayv2-integrationresponse.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const integrationresponse = await AWS.ApiGatewayV2.IntegrationResponse(
  "integrationresponse-example",
  {
    IntegrationId: "example-integrationid",
    IntegrationResponseKey: "example-integrationresponsekey",
    ApiId: "example-apiid",
  }
);
```

