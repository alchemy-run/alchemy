---
title: Managing AWS SageMaker ImageVersions with Alchemy
description: Learn how to create, update, and manage AWS SageMaker ImageVersions using Alchemy Cloud Control.
---

# ImageVersion

The ImageVersion resource lets you create and manage [AWS SageMaker ImageVersions](https://docs.aws.amazon.com/sagemaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-imageversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const imageversion = await AWS.SageMaker.ImageVersion("imageversion-example", {
  ImageName: "imageversion-image",
  BaseImage: "example-baseimage",
});
```

