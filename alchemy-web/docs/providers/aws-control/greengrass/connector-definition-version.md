---
title: Managing AWS Greengrass ConnectorDefinitionVersions with Alchemy
description: Learn how to create, update, and manage AWS Greengrass ConnectorDefinitionVersions using Alchemy Cloud Control.
---

# ConnectorDefinitionVersion

The ConnectorDefinitionVersion resource lets you create and manage [AWS Greengrass ConnectorDefinitionVersions](https://docs.aws.amazon.com/greengrass/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-greengrass-connectordefinitionversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const connectordefinitionversion = await AWS.Greengrass.ConnectorDefinitionVersion(
  "connectordefinitionversion-example",
  { Connectors: [], ConnectorDefinitionId: "example-connectordefinitionid" }
);
```

