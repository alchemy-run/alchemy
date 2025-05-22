---
title: Managing AWS DataPipeline Pipelines with Alchemy
description: Learn how to create, update, and manage AWS DataPipeline Pipelines using Alchemy Cloud Control.
---

# Pipeline

The Pipeline resource lets you create and manage [AWS DataPipeline Pipelines](https://docs.aws.amazon.com/datapipeline/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-datapipeline-pipeline.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const pipeline = await AWS.DataPipeline.Pipeline("pipeline-example", {
  Name: "pipeline-",
  Description: "A pipeline resource managed by Alchemy",
});
```

## Advanced Configuration

Create a pipeline with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPipeline = await AWS.DataPipeline.Pipeline("advanced-pipeline", {
  Name: "pipeline-",
  Description: "A pipeline resource managed by Alchemy",
});
```

