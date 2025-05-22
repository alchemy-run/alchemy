---
title: Managing AWS Deadline QueueFleetAssociations with Alchemy
description: Learn how to create, update, and manage AWS Deadline QueueFleetAssociations using Alchemy Cloud Control.
---

# QueueFleetAssociation

The QueueFleetAssociation resource lets you create and manage [AWS Deadline QueueFleetAssociations](https://docs.aws.amazon.com/deadline/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-deadline-queuefleetassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const queuefleetassociation = await AWS.Deadline.QueueFleetAssociation(
  "queuefleetassociation-example",
  { FleetId: "example-fleetid", QueueId: "example-queueid", FarmId: "example-farmid" }
);
```

