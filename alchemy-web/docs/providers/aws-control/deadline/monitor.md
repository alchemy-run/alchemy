---
title: Managing AWS Deadline Monitors with Alchemy
description: Learn how to create, update, and manage AWS Deadline Monitors using Alchemy Cloud Control.
---

# Monitor

The Monitor resource lets you create and manage [AWS Deadline Monitors](https://docs.aws.amazon.com/deadline/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-deadline-monitor.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const monitor = await AWS.Deadline.Monitor("monitor-example", {
  IdentityCenterInstanceArn: "example-identitycenterinstancearn",
  Subdomain: "example-subdomain",
  DisplayName: "monitor-display",
  RoleArn: "example-rolearn",
});
```

