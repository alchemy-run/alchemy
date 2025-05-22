---
title: Managing AWS WAF SizeConstraintSets with Alchemy
description: Learn how to create, update, and manage AWS WAF SizeConstraintSets using Alchemy Cloud Control.
---

# SizeConstraintSet

The SizeConstraintSet resource lets you create and manage [AWS WAF SizeConstraintSets](https://docs.aws.amazon.com/waf/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-waf-sizeconstraintset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const sizeconstraintset = await AWS.WAF.SizeConstraintSet("sizeconstraintset-example", {
  Name: "sizeconstraintset-",
  SizeConstraints: [],
});
```

