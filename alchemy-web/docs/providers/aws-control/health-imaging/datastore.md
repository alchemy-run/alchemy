---
title: Managing AWS HealthImaging Datastores with Alchemy
description: Learn how to create, update, and manage AWS HealthImaging Datastores using Alchemy Cloud Control.
---

# Datastore

The Datastore resource lets you create and manage [AWS HealthImaging Datastores](https://docs.aws.amazon.com/healthimaging/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-healthimaging-datastore.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const datastore = await AWS.HealthImaging.Datastore("datastore-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a datastore with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDatastore = await AWS.HealthImaging.Datastore("advanced-datastore", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

