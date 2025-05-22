---
title: Managing AWS CloudTrail ResourcePolicys with Alchemy
description: Learn how to create, update, and manage AWS CloudTrail ResourcePolicys using Alchemy Cloud Control.
---

# ResourcePolicy

The ResourcePolicy resource lets you create and manage [AWS CloudTrail ResourcePolicys](https://docs.aws.amazon.com/cloudtrail/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudtrail-resourcepolicy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resourcepolicy = await AWS.CloudTrail.ResourcePolicy("resourcepolicy-example", {
  ResourceArn: "example-resourcearn",
  ResourcePolicy: {},
});
```

