<!-- Docs for the generated AWS.IoTSiteWise bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeAsset

Runtime binding for `iotsitewise:DescribeAsset` — read the bound asset's
full description (including its properties with their service-assigned
ids and names) from a deployed Lambda or Task. Use it to resolve a
property's id by name before reading or ingesting values.

### Describing the Bound Asset
Provide the `DescribeAssetHttp` implementation layer on the Function
effect, bind the asset in the init phase, then call the returned client
at runtime.

**Example:** Resolve a Property Id by Name
```typescript
// init
const describeAsset = yield* AWS.IoTSiteWise.DescribeAsset(asset);

// runtime
const described = yield* describeAsset();
const propertyId = described.assetProperties.find(
  (p) => p.name === "Temperature",
)?.id;
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTSiteWise.DescribeAssetHttp))
```

@binding

## DescribeAsset.Request

Request for {@link DescribeAsset}. The bound asset's id is injected
automatically.

## ExecuteQuery

Runtime binding for `iotsitewise:ExecuteQuery` — run a SiteWise SQL
query across all asset models, assets, measurements, metrics, and
transforms in the account from a deployed Lambda or Task.

The query surface is account-wide, so the binding grants the action on
`Resource: ["*"]` and takes no bound resource.

### Querying Asset Data with SQL
Provide the `ExecuteQueryHttp` implementation layer on the Function
effect, bind in the init phase (no resource argument), then call the
returned client at runtime.

**Example:** Find an Asset by Name
```typescript
// init — account-level binding takes no resource
const executeQuery = yield* AWS.IoTSiteWise.ExecuteQuery();

// runtime
const { rows } = yield* executeQuery({
  queryStatement:
    "SELECT asset_id, asset_name FROM asset WHERE asset_name = 'Pump1'",
});
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTSiteWise.ExecuteQueryHttp))
```

@binding

## ExecuteQuery.Request

Request for {@link ExecuteQuery}.

## GetAssetPropertyAggregates

Runtime binding for `iotsitewise:GetAssetPropertyAggregates` — read
pre-computed aggregates (`AVERAGE`, `MINIMUM`, `MAXIMUM`, `SUM`, `COUNT`,
`STANDARD_DEVIATION`) of one property of the bound asset over a time
range at a fixed resolution from a deployed Lambda or Task.

### Reading Aggregates
Provide the `GetAssetPropertyAggregatesHttp` implementation layer on the
Function effect, bind the asset in the init phase, then call the returned
client at runtime.

**Example:** Hourly Average over the Last Day
```typescript
// init
const getAggregates = yield* AWS.IoTSiteWise.GetAssetPropertyAggregates(asset);

// runtime
const now = yield* Effect.sync(() => new Date());
const { aggregatedValues } = yield* getAggregates({
  propertyId,
  aggregateTypes: ["AVERAGE"],
  resolution: "1h",
  startDate: new Date(now.getTime() - 86_400_000),
  endDate: now,
});
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTSiteWise.GetAssetPropertyAggregatesHttp))
```

@binding

## GetAssetPropertyAggregates.Request

Request for {@link GetAssetPropertyAggregates}. The bound asset's id is
injected automatically.

## GetAssetPropertyValue

Runtime binding for `iotsitewise:GetAssetPropertyValue` — read the
current (latest) timestamp-quality-value of one property of the bound
asset from a deployed Lambda or Task.

### Reading Current Values
Provide the `GetAssetPropertyValueHttp` implementation layer on the
Function effect, bind the asset in the init phase, then call the returned
client at runtime.

**Example:** Read the Latest Temperature
```typescript
// init
const getValue = yield* AWS.IoTSiteWise.GetAssetPropertyValue(asset);

// runtime
const { propertyValue } = yield* getValue({ propertyId });
const celsius = propertyValue?.value.doubleValue;
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTSiteWise.GetAssetPropertyValueHttp))
```

@binding

## GetAssetPropertyValue.Request

Request for {@link GetAssetPropertyValue}. The bound asset's id is
injected automatically; identify the property with `propertyId` (or a
`propertyAlias`, which authorizes against the time-series resource
instead of the bound asset).

## GetAssetPropertyValueHistory

Runtime binding for `iotsitewise:GetAssetPropertyValueHistory` — read the
historical timestamp-quality-values of one property of the bound asset
over a time range from a deployed Lambda or Task.

### Reading Value History
Provide the `GetAssetPropertyValueHistoryHttp` implementation layer on
the Function effect, bind the asset in the init phase, then call the
returned client at runtime. Page through large ranges with `nextToken`.

**Example:** Read the Last Hour of Values
```typescript
// init
const getHistory = yield* AWS.IoTSiteWise.GetAssetPropertyValueHistory(asset);

// runtime
const now = yield* Effect.sync(() => new Date());
const { assetPropertyValueHistory } = yield* getHistory({
  propertyId,
  startDate: new Date(now.getTime() - 3_600_000),
  endDate: now,
  timeOrdering: "DESCENDING",
});
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTSiteWise.GetAssetPropertyValueHistoryHttp))
```

@binding

## GetAssetPropertyValueHistory.Request

Request for {@link GetAssetPropertyValueHistory}. The bound asset's id is
injected automatically.

## GetInterpolatedAssetPropertyValues

Runtime binding for `iotsitewise:GetInterpolatedAssetPropertyValues` —
compute interpolated values (`LINEAR_INTERPOLATION` or
`LOCF_INTERPOLATION`) of one property of the bound asset at a fixed
interval from a deployed Lambda or Task.

### Reading Interpolated Values
Provide the `GetInterpolatedAssetPropertyValuesHttp` implementation layer
on the Function effect, bind the asset in the init phase, then call the
returned client at runtime.

**Example:** Interpolate at 1-Minute Intervals
```typescript
// init
const getInterpolated =
  yield* AWS.IoTSiteWise.GetInterpolatedAssetPropertyValues(asset);

// runtime
const now = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
const { interpolatedAssetPropertyValues } = yield* getInterpolated({
  propertyId,
  startTimeInSeconds: now - 3600,
  endTimeInSeconds: now,
  intervalInSeconds: 60,
  quality: "GOOD",
  type: "LINEAR_INTERPOLATION",
});
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTSiteWise.GetInterpolatedAssetPropertyValuesHttp))
```

@binding

## GetInterpolatedAssetPropertyValues.Request

Request for {@link GetInterpolatedAssetPropertyValues}. The bound asset's
id is injected automatically.

The `startTimeInSeconds` / `endTimeInSeconds` / `intervalInSeconds`
fields keep their wire names: they are epoch timestamps and an interval
that are part of this operation's request shape, passed through verbatim.

## ListAssetProperties

Runtime binding for `iotsitewise:ListAssetProperties` — page through the
bound asset's property summaries (ids, aliases, paths) from a deployed
Lambda or Task.

### Listing Asset Properties
Provide the `ListAssetPropertiesHttp` implementation layer on the
Function effect, bind the asset in the init phase, then call the returned
client at runtime. Pass `filter: "ALL"` to include properties inherited
from composite models.

**Example:** List All Properties
```typescript
// init
const listProperties = yield* AWS.IoTSiteWise.ListAssetProperties(asset);

// runtime
const { assetPropertySummaries } = yield* listProperties({ filter: "ALL" });
// on the Function effect:
// .pipe(Effect.provide(AWS.IoTSiteWise.ListAssetPropertiesHttp))
```

@binding

## ListAssetProperties.Request

Request for {@link ListAssetProperties}. The bound asset's id is injected
automatically.
