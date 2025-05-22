---
title: Managing AWS ServiceCatalogAppRegistry AttributeGroups with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalogAppRegistry AttributeGroups using Alchemy Cloud Control.
---

# AttributeGroup

The AttributeGroup resource lets you create and manage [AWS ServiceCatalogAppRegistry AttributeGroups](https://docs.aws.amazon.com/servicecatalogappregistry/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalogappregistry-attributegroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const attributegroup = await AWS.ServiceCatalogAppRegistry.AttributeGroup(
  "attributegroup-example",
  {
    Attributes: {},
    Name: "attributegroup-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
    Description: "A attributegroup resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a attributegroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAttributeGroup = await AWS.ServiceCatalogAppRegistry.AttributeGroup(
  "advanced-attributegroup",
  {
    Attributes: {},
    Name: "attributegroup-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A attributegroup resource managed by Alchemy",
  }
);
```

