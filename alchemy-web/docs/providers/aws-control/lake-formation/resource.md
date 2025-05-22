---
title: Managing AWS LakeFormation Resources with Alchemy
description: Learn how to create, update, and manage AWS LakeFormation Resources using Alchemy Cloud Control.
---

# Resource

The Resource resource lets you create and manage [AWS LakeFormation Resources](https://docs.aws.amazon.com/lakeformation/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lakeformation-resource.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resource = await AWS.LakeFormation.Resource("resource-example", {
  ResourceArn: "example-resourcearn",
  UseServiceLinkedRole: true,
});
```

