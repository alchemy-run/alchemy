---
title: Managing AWS Route53RecoveryControl ControlPanels with Alchemy
description: Learn how to create, update, and manage AWS Route53RecoveryControl ControlPanels using Alchemy Cloud Control.
---

# ControlPanel

The ControlPanel resource lets you create and manage [AWS Route53RecoveryControl ControlPanels](https://docs.aws.amazon.com/route53recoverycontrol/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53recoverycontrol-controlpanel.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const controlpanel = await AWS.Route53RecoveryControl.ControlPanel("controlpanel-example", {
  Name: "controlpanel-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a controlpanel with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedControlPanel = await AWS.Route53RecoveryControl.ControlPanel(
  "advanced-controlpanel",
  {
    Name: "controlpanel-",
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

