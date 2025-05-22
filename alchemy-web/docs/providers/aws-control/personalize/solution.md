---
title: Managing AWS Personalize Solutions with Alchemy
description: Learn how to create, update, and manage AWS Personalize Solutions using Alchemy Cloud Control.
---

# Solution

The Solution resource lets you create and manage [AWS Personalize Solutions](https://docs.aws.amazon.com/personalize/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-personalize-solution.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const solution = await AWS.Personalize.Solution("solution-example", {
  DatasetGroupArn: "example-datasetgrouparn",
  Name: "solution-",
});
```

