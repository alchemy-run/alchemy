---
title: Managing AWS DAX ParameterGroups with Alchemy
description: Learn how to create, update, and manage AWS DAX ParameterGroups using Alchemy Cloud Control.
---

# ParameterGroup

The ParameterGroup resource lets you create and manage [AWS DAX ParameterGroups](https://docs.aws.amazon.com/dax/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dax-parametergroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const parametergroup = await AWS.DAX.ParameterGroup("parametergroup-example", {
  Description: "A parametergroup resource managed by Alchemy",
});
```

## Advanced Configuration

Create a parametergroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedParameterGroup = await AWS.DAX.ParameterGroup("advanced-parametergroup", {
  Description: "A parametergroup resource managed by Alchemy",
});
```

