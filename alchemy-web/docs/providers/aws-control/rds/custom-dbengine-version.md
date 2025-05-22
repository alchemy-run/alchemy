---
title: Managing AWS RDS CustomDBEngineVersions with Alchemy
description: Learn how to create, update, and manage AWS RDS CustomDBEngineVersions using Alchemy Cloud Control.
---

# CustomDBEngineVersion

The CustomDBEngineVersion resource lets you create and manage [AWS RDS CustomDBEngineVersions](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-customdbengineversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const customdbengineversion = await AWS.RDS.CustomDBEngineVersion("customdbengineversion-example", {
  EngineVersion: "example-engineversion",
  Engine: "example-engine",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A customdbengineversion resource managed by Alchemy",
});
```

## Advanced Configuration

Create a customdbengineversion with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCustomDBEngineVersion = await AWS.RDS.CustomDBEngineVersion(
  "advanced-customdbengineversion",
  {
    EngineVersion: "example-engineversion",
    Engine: "example-engine",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A customdbengineversion resource managed by Alchemy",
  }
);
```

