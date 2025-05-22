---
title: Managing AWS FMS ResourceSets with Alchemy
description: Learn how to create, update, and manage AWS FMS ResourceSets using Alchemy Cloud Control.
---

# ResourceSet

The ResourceSet resource lets you create and manage [AWS FMS ResourceSets](https://docs.aws.amazon.com/fms/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-fms-resourceset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resourceset = await AWS.FMS.ResourceSet("resourceset-example", {
  ResourceTypeList: ["example-resourcetypelist-1"],
  Name: "resourceset-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A resourceset resource managed by Alchemy",
});
```

## Advanced Configuration

Create a resourceset with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedResourceSet = await AWS.FMS.ResourceSet("advanced-resourceset", {
  ResourceTypeList: ["example-resourcetypelist-1"],
  Name: "resourceset-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A resourceset resource managed by Alchemy",
});
```

