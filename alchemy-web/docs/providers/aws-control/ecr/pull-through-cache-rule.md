---
title: Managing AWS ECR PullThroughCacheRules with Alchemy
description: Learn how to create, update, and manage AWS ECR PullThroughCacheRules using Alchemy Cloud Control.
---

# PullThroughCacheRule

The PullThroughCacheRule resource lets you create and manage [AWS ECR PullThroughCacheRules](https://docs.aws.amazon.com/ecr/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ecr-pullthroughcacherule.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const pullthroughcacherule = await AWS.ECR.PullThroughCacheRule("pullthroughcacherule-example", {});
```

