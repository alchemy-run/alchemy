---
title: Managing AWS ApiGateway Models with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway Models using Alchemy Cloud Control.
---

# Model

The Model resource lets you create and manage [AWS ApiGateway Models](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-model.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const model = await AWS.ApiGateway.Model("model-example", {
  RestApiId: "example-restapiid",
  Description: "A model resource managed by Alchemy",
});
```

## Advanced Configuration

Create a model with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedModel = await AWS.ApiGateway.Model("advanced-model", {
  RestApiId: "example-restapiid",
  Description: "A model resource managed by Alchemy",
});
```

