---
title: Managing AWS Glue Partitions with Alchemy
description: Learn how to create, update, and manage AWS Glue Partitions using Alchemy Cloud Control.
---

# Partition

The Partition resource lets you create and manage [AWS Glue Partitions](https://docs.aws.amazon.com/glue/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-glue-partition.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const partition = await AWS.Glue.Partition("partition-example", {
  TableName: "partition-table",
  DatabaseName: "partition-database",
  CatalogId: "example-catalogid",
  PartitionInput: "example-partitioninput",
});
```

