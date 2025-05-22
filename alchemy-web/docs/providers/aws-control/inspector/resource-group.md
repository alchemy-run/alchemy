---
title: Managing AWS Inspector ResourceGroups with Alchemy
description: Learn how to create, update, and manage AWS Inspector ResourceGroups using Alchemy Cloud Control.
---

# ResourceGroup

The ResourceGroup resource lets you create and manage [AWS Inspector ResourceGroups](https://docs.aws.amazon.com/inspector/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-inspector-resourcegroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resourcegroup = await AWS.Inspector.ResourceGroup("resourcegroup-example", {
  ResourceGroupTags: [],
});
```

