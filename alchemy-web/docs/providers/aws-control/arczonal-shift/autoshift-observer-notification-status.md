---
title: Managing AWS ARCZonalShift AutoshiftObserverNotificationStatuss with Alchemy
description: Learn how to create, update, and manage AWS ARCZonalShift AutoshiftObserverNotificationStatuss using Alchemy Cloud Control.
---

# AutoshiftObserverNotificationStatus

The AutoshiftObserverNotificationStatus resource lets you create and manage [AWS ARCZonalShift AutoshiftObserverNotificationStatuss](https://docs.aws.amazon.com/arczonalshift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-arczonalshift-autoshiftobservernotificationstatus.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const autoshiftobservernotificationstatus =
  await AWS.ARCZonalShift.AutoshiftObserverNotificationStatus(
    "autoshiftobservernotificationstatus-example",
    { Status: "example-status" }
  );
```

