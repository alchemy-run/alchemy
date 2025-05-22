---
title: Managing AWS Location GeofenceCollections with Alchemy
description: Learn how to create, update, and manage AWS Location GeofenceCollections using Alchemy Cloud Control.
---

# GeofenceCollection

The GeofenceCollection resource lets you create and manage [AWS Location GeofenceCollections](https://docs.aws.amazon.com/location/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-location-geofencecollection.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const geofencecollection = await AWS.Location.GeofenceCollection("geofencecollection-example", {
  CollectionName: "geofencecollection-collection",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A geofencecollection resource managed by Alchemy",
});
```

## Advanced Configuration

Create a geofencecollection with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedGeofenceCollection = await AWS.Location.GeofenceCollection(
  "advanced-geofencecollection",
  {
    CollectionName: "geofencecollection-collection",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A geofencecollection resource managed by Alchemy",
  }
);
```

