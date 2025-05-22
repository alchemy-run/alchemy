---
title: Managing AWS ServiceCatalogAppRegistry AttributeGroupAssociations with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalogAppRegistry AttributeGroupAssociations using Alchemy Cloud Control.
---

# AttributeGroupAssociation

The AttributeGroupAssociation resource lets you create and manage [AWS ServiceCatalogAppRegistry AttributeGroupAssociations](https://docs.aws.amazon.com/servicecatalogappregistry/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalogappregistry-attributegroupassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const attributegroupassociation = await AWS.ServiceCatalogAppRegistry.AttributeGroupAssociation(
  "attributegroupassociation-example",
  { AttributeGroup: "example-attributegroup", Application: "example-application" }
);
```

