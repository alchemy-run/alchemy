---
title: Managing AWS WAFRegional ByteMatchSets with Alchemy
description: Learn how to create, update, and manage AWS WAFRegional ByteMatchSets using Alchemy Cloud Control.
---

# ByteMatchSet

The ByteMatchSet resource lets you create and manage [AWS WAFRegional ByteMatchSets](https://docs.aws.amazon.com/wafregional/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-wafregional-bytematchset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const bytematchset = await AWS.WAFRegional.ByteMatchSet("bytematchset-example", {
  Name: "bytematchset-",
});
```

