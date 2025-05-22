---
title: Managing AWS RDS OptionGroups with Alchemy
description: Learn how to create, update, and manage AWS RDS OptionGroups using Alchemy Cloud Control.
---

# OptionGroup

The OptionGroup resource lets you create and manage [AWS RDS OptionGroups](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-optiongroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const optiongroup = await AWS.RDS.OptionGroup("optiongroup-example", {
  OptionGroupDescription: "A optiongroup resource managed by Alchemy",
  MajorEngineVersion: "example-majorengineversion",
  EngineName: "optiongroup-engine",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a optiongroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedOptionGroup = await AWS.RDS.OptionGroup("advanced-optiongroup", {
  OptionGroupDescription: "A optiongroup resource managed by Alchemy",
  MajorEngineVersion: "example-majorengineversion",
  EngineName: "optiongroup-engine",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

