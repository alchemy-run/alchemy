---
title: Managing AWS Rekognition Collections with Alchemy
description: Learn how to create, update, and manage AWS Rekognition Collections using Alchemy Cloud Control.
---

# Collection

The Collection resource lets you create and manage [AWS Rekognition Collections](https://docs.aws.amazon.com/rekognition/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rekognition-collection.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const collection = await AWS.Rekognition.Collection("collection-example", {
  CollectionId: "example-collectionid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a collection with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCollection = await AWS.Rekognition.Collection("advanced-collection", {
  CollectionId: "example-collectionid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

