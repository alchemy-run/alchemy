---
title: Managing AWS ServiceCatalog TagOptions with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalog TagOptions using Alchemy Cloud Control.
---

# TagOption

The TagOption resource lets you create and manage [AWS ServiceCatalog TagOptions](https://docs.aws.amazon.com/servicecatalog/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalog-tagoption.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const tagoption = await AWS.ServiceCatalog.TagOption("tagoption-example", {
  Value: "example-value",
  Key: "example-key",
});
```

