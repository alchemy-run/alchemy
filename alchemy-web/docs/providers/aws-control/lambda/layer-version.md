---
title: Managing AWS Lambda LayerVersions with Alchemy
description: Learn how to create, update, and manage AWS Lambda LayerVersions using Alchemy Cloud Control.
---

# LayerVersion

The LayerVersion resource lets you create and manage [AWS Lambda LayerVersions](https://docs.aws.amazon.com/lambda/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-layerversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const layerversion = await AWS.Lambda.LayerVersion("layerversion-example", {
  Content: "example-content",
  Description: "A layerversion resource managed by Alchemy",
});
```

## Advanced Configuration

Create a layerversion with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLayerVersion = await AWS.Lambda.LayerVersion("advanced-layerversion", {
  Content: "example-content",
  Description: "A layerversion resource managed by Alchemy",
});
```

