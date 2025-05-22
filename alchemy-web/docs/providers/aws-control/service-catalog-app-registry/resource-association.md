---
title: Managing AWS ServiceCatalogAppRegistry ResourceAssociations with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalogAppRegistry ResourceAssociations using Alchemy Cloud Control.
---

# ResourceAssociation

The ResourceAssociation resource lets you create and manage [AWS ServiceCatalogAppRegistry ResourceAssociations](https://docs.aws.amazon.com/servicecatalogappregistry/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalogappregistry-resourceassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resourceassociation = await AWS.ServiceCatalogAppRegistry.ResourceAssociation(
  "resourceassociation-example",
  {
    Resource: "example-resource",
    ResourceType: "example-resourcetype",
    Application: "example-application",
  }
);
```

