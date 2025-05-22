---
title: Managing AWS PCAConnectorAD DirectoryRegistrations with Alchemy
description: Learn how to create, update, and manage AWS PCAConnectorAD DirectoryRegistrations using Alchemy Cloud Control.
---

# DirectoryRegistration

The DirectoryRegistration resource lets you create and manage [AWS PCAConnectorAD DirectoryRegistrations](https://docs.aws.amazon.com/pcaconnectorad/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pcaconnectorad-directoryregistration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const directoryregistration = await AWS.PCAConnectorAD.DirectoryRegistration(
  "directoryregistration-example",
  { DirectoryId: "example-directoryid", Tags: { Environment: "production", ManagedBy: "Alchemy" } }
);
```

## Advanced Configuration

Create a directoryregistration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDirectoryRegistration = await AWS.PCAConnectorAD.DirectoryRegistration(
  "advanced-directoryregistration",
  {
    DirectoryId: "example-directoryid",
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

