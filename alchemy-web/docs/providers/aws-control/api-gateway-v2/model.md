---
title: Managing AWS ApiGatewayV2 Models with Alchemy
description: Learn how to create, update, and manage AWS ApiGatewayV2 Models using Alchemy Cloud Control.
---

# Model

The Model resource lets you create and manage [AWS ApiGatewayV2 Models](https://docs.aws.amazon.com/apigatewayv2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigatewayv2-model.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const model = await AWS.ApiGatewayV2.Model("model-example", {
  Schema: {},
  ApiId: "example-apiid",
  Name: "model-",
  Description: "A model resource managed by Alchemy",
});
```

## Advanced Configuration

Create a model with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedModel = await AWS.ApiGatewayV2.Model("advanced-model", {
  Schema: {},
  ApiId: "example-apiid",
  Name: "model-",
  Description: "A model resource managed by Alchemy",
});
```

