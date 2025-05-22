---
title: Managing AWS LakeFormation Tags with Alchemy
description: Learn how to create, update, and manage AWS LakeFormation Tags using Alchemy Cloud Control.
---

# Tag

The Tag resource lets you create and manage [AWS LakeFormation Tags](https://docs.aws.amazon.com/lakeformation/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lakeformation-tag.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const tag = await AWS.LakeFormation.Tag("tag-example", {
  TagKey: "example-tagkey",
  TagValues: ["example-tagvalues-1"],
});
```

