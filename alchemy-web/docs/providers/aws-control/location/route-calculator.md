---
title: Managing AWS Location RouteCalculators with Alchemy
description: Learn how to create, update, and manage AWS Location RouteCalculators using Alchemy Cloud Control.
---

# RouteCalculator

The RouteCalculator resource lets you create and manage [AWS Location RouteCalculators](https://docs.aws.amazon.com/location/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-location-routecalculator.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const routecalculator = await AWS.Location.RouteCalculator("routecalculator-example", {
  CalculatorName: "routecalculator-calculator",
  DataSource: "example-datasource",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A routecalculator resource managed by Alchemy",
});
```

## Advanced Configuration

Create a routecalculator with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRouteCalculator = await AWS.Location.RouteCalculator("advanced-routecalculator", {
  CalculatorName: "routecalculator-calculator",
  DataSource: "example-datasource",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A routecalculator resource managed by Alchemy",
});
```

