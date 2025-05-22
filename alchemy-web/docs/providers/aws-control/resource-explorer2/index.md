---
title: Managing AWS ResourceExplorer2 Indexs with Alchemy
description: Learn how to create, update, and manage AWS ResourceExplorer2 Indexs using Alchemy Cloud Control.
---

# Index

The Index resource lets you create and manage [AWS ResourceExplorer2 Indexs](https://docs.aws.amazon.com/resourceexplorer2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-resourceexplorer2-index.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const index = await AWS.ResourceExplorer2.Index("index-example", {
  Type: "example-type",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a index with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIndex = await AWS.ResourceExplorer2.Index("advanced-index", {
  Type: "example-type",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

