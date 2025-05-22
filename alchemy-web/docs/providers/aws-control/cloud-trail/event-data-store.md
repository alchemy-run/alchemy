---
title: Managing AWS CloudTrail EventDataStores with Alchemy
description: Learn how to create, update, and manage AWS CloudTrail EventDataStores using Alchemy Cloud Control.
---

# EventDataStore

The EventDataStore resource lets you create and manage [AWS CloudTrail EventDataStores](https://docs.aws.amazon.com/cloudtrail/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudtrail-eventdatastore.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const eventdatastore = await AWS.CloudTrail.EventDataStore("eventdatastore-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a eventdatastore with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEventDataStore = await AWS.CloudTrail.EventDataStore("advanced-eventdatastore", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

