---
title: Managing AWS ServiceCatalog TagOptionAssociations with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalog TagOptionAssociations using Alchemy Cloud Control.
---

# TagOptionAssociation

The TagOptionAssociation resource lets you create and manage [AWS ServiceCatalog TagOptionAssociations](https://docs.aws.amazon.com/servicecatalog/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalog-tagoptionassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const tagoptionassociation = await AWS.ServiceCatalog.TagOptionAssociation(
  "tagoptionassociation-example",
  { TagOptionId: "example-tagoptionid", ResourceId: "example-resourceid" }
);
```

