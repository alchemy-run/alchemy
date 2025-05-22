---
title: Managing AWS GuardDuty Masters with Alchemy
description: Learn how to create, update, and manage AWS GuardDuty Masters using Alchemy Cloud Control.
---

# Master

The Master resource lets you create and manage [AWS GuardDuty Masters](https://docs.aws.amazon.com/guardduty/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-guardduty-master.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const master = await AWS.GuardDuty.Master("master-example", {
  DetectorId: "example-detectorid",
  MasterId: "example-masterid",
});
```

