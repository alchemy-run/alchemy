---
title: Managing AWS WAFRegional SizeConstraintSets with Alchemy
description: Learn how to create, update, and manage AWS WAFRegional SizeConstraintSets using Alchemy Cloud Control.
---

# SizeConstraintSet

The SizeConstraintSet resource lets you create and manage [AWS WAFRegional SizeConstraintSets](https://docs.aws.amazon.com/wafregional/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-wafregional-sizeconstraintset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const sizeconstraintset = await AWS.WAFRegional.SizeConstraintSet("sizeconstraintset-example", {
  Name: "sizeconstraintset-",
});
```

