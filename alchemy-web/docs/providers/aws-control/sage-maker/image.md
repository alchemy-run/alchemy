---
title: Managing AWS SageMaker Images with Alchemy
description: Learn how to create, update, and manage AWS SageMaker Images using Alchemy Cloud Control.
---

# Image

The Image resource lets you create and manage [AWS SageMaker Images](https://docs.aws.amazon.com/sagemaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-image.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const image = await AWS.SageMaker.Image("image-example", {
  ImageName: "image-image",
  ImageRoleArn: "example-imagerolearn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a image with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedImage = await AWS.SageMaker.Image("advanced-image", {
  ImageName: "image-image",
  ImageRoleArn: "example-imagerolearn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

