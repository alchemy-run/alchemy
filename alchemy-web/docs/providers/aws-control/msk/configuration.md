---
title: Managing AWS MSK Configurations with Alchemy
description: Learn how to create, update, and manage AWS MSK Configurations using Alchemy Cloud Control.
---

# Configuration

The Configuration resource lets you create and manage [AWS MSK Configurations](https://docs.aws.amazon.com/msk/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-msk-configuration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const configuration = await AWS.MSK.Configuration("configuration-example", {
  ServerProperties: "example-serverproperties",
  Name: "configuration-",
  Description: "A configuration resource managed by Alchemy",
});
```

## Advanced Configuration

Create a configuration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedConfiguration = await AWS.MSK.Configuration("advanced-configuration", {
  ServerProperties: "example-serverproperties",
  Name: "configuration-",
  Description: "A configuration resource managed by Alchemy",
});
```

