---
title: Managing AWS WAF ByteMatchSets with Alchemy
description: Learn how to create, update, and manage AWS WAF ByteMatchSets using Alchemy Cloud Control.
---

# ByteMatchSet

The ByteMatchSet resource lets you create and manage [AWS WAF ByteMatchSets](https://docs.aws.amazon.com/waf/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-waf-bytematchset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const bytematchset = await AWS.WAF.ByteMatchSet("bytematchset-example", { Name: "bytematchset-" });
```

