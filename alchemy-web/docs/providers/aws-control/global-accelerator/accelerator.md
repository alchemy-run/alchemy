---
title: Managing AWS GlobalAccelerator Accelerators with Alchemy
description: Learn how to create, update, and manage AWS GlobalAccelerator Accelerators using Alchemy Cloud Control.
---

# Accelerator

The Accelerator resource lets you create and manage [AWS GlobalAccelerator Accelerators](https://docs.aws.amazon.com/globalaccelerator/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-globalaccelerator-accelerator.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const accelerator = await AWS.GlobalAccelerator.Accelerator("accelerator-example", {
  Name: "accelerator-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a accelerator with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAccelerator = await AWS.GlobalAccelerator.Accelerator("advanced-accelerator", {
  Name: "accelerator-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

