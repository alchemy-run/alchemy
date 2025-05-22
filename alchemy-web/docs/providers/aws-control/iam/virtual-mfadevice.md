---
title: Managing AWS IAM VirtualMFADevices with Alchemy
description: Learn how to create, update, and manage AWS IAM VirtualMFADevices using Alchemy Cloud Control.
---

# VirtualMFADevice

The VirtualMFADevice resource lets you create and manage [AWS IAM VirtualMFADevices](https://docs.aws.amazon.com/iam/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-virtualmfadevice.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const virtualmfadevice = await AWS.IAM.VirtualMFADevice("virtualmfadevice-example", {
  Users: ["example-users-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a virtualmfadevice with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVirtualMFADevice = await AWS.IAM.VirtualMFADevice("advanced-virtualmfadevice", {
  Users: ["example-users-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

