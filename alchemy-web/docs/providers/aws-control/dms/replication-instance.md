---
title: Managing AWS DMS ReplicationInstances with Alchemy
description: Learn how to create, update, and manage AWS DMS ReplicationInstances using Alchemy Cloud Control.
---

# ReplicationInstance

The ReplicationInstance resource lets you create and manage [AWS DMS ReplicationInstances](https://docs.aws.amazon.com/dms/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dms-replicationinstance.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const replicationinstance = await AWS.DMS.ReplicationInstance("replicationinstance-example", {
  ReplicationInstanceClass: "example-replicationinstanceclass",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a replicationinstance with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedReplicationInstance = await AWS.DMS.ReplicationInstance(
  "advanced-replicationinstance",
  {
    ReplicationInstanceClass: "example-replicationinstanceclass",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

