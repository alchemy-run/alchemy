---
title: Managing AWS Personalize DatasetGroups with Alchemy
description: Learn how to create, update, and manage AWS Personalize DatasetGroups using Alchemy Cloud Control.
---

# DatasetGroup

The DatasetGroup resource lets you create and manage [AWS Personalize DatasetGroups](https://docs.aws.amazon.com/personalize/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-personalize-datasetgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const datasetgroup = await AWS.Personalize.DatasetGroup("datasetgroup-example", {
  Name: "datasetgroup-",
});
```

