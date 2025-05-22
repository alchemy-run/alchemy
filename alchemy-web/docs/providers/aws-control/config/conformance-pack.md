---
title: Managing AWS Config ConformancePacks with Alchemy
description: Learn how to create, update, and manage AWS Config ConformancePacks using Alchemy Cloud Control.
---

# ConformancePack

The ConformancePack resource lets you create and manage [AWS Config ConformancePacks](https://docs.aws.amazon.com/config/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-config-conformancepack.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const conformancepack = await AWS.Config.ConformancePack("conformancepack-example", {
  ConformancePackName: "conformancepack-conformancepack",
});
```

