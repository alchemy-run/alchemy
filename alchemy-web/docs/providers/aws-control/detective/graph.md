---
title: Managing AWS Detective Graphs with Alchemy
description: Learn how to create, update, and manage AWS Detective Graphs using Alchemy Cloud Control.
---

# Graph

The Graph resource lets you create and manage [AWS Detective Graphs](https://docs.aws.amazon.com/detective/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-detective-graph.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const graph = await AWS.Detective.Graph("graph-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a graph with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedGraph = await AWS.Detective.Graph("advanced-graph", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

