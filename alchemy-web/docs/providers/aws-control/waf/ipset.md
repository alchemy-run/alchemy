---
title: Managing AWS WAF IPSets with Alchemy
description: Learn how to create, update, and manage AWS WAF IPSets using Alchemy Cloud Control.
---

# IPSet

The IPSet resource lets you create and manage [AWS WAF IPSets](https://docs.aws.amazon.com/waf/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-waf-ipset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ipset = await AWS.WAF.IPSet("ipset-example", { Name: "ipset-" });
```

