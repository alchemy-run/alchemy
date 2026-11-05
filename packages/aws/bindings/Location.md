<!-- Docs for the generated AWS.Location bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchDeleteDevicePositionHistory

Deletes the complete position history of up to 100 devices from the tracker.

Runtime binding for the `BatchDeleteDevicePositionHistory` operation (IAM action
`geo:BatchDeleteDevicePositionHistory`), scoped to one {@link Tracker}. Provide the implementation with
`Effect.provide(AWS.Location.BatchDeleteDevicePositionHistoryHttp)`.

### Updating Device Positions
**Example:** Purge a Device's Position History
```typescript
const deleteHistory = yield* Location.BatchDeleteDevicePositionHistory(tracker);

yield* deleteHistory({ DeviceIds: ["vehicle-1"] });
```

@binding

## BatchDeleteDevicePositionHistory.Request

`BatchDeleteDevicePositionHistory` request with `TrackerName` injected from the bound
resource.

## BatchDeleteGeofence

Deletes up to 10 geofences from the collection in one call.

Runtime binding for the `BatchDeleteGeofence` operation (IAM action
`geo:BatchDeleteGeofence`), scoped to one {@link GeofenceCollection}. Provide the implementation with
`Effect.provide(AWS.Location.BatchDeleteGeofenceHttp)`.

### Managing Geofences
**Example:** Delete Geofences
```typescript
const batchDelete = yield* Location.BatchDeleteGeofence(collection);

yield* batchDelete({ GeofenceIds: ["warehouse"] });
```

@binding

## BatchDeleteGeofence.Request

`BatchDeleteGeofence` request with `CollectionName` injected from the bound
resource.

## BatchEvaluateGeofences

Evaluates device positions against the collection's geofences, emitting ENTER/EXIT events to EventBridge for linked trackers.

Runtime binding for the `BatchEvaluateGeofences` operation (IAM action
`geo:BatchEvaluateGeofences`), scoped to one {@link GeofenceCollection}. Provide the implementation with
`Effect.provide(AWS.Location.BatchEvaluateGeofencesHttp)`.

### Evaluating Positions Against Geofences
**Example:** Evaluate Positions
```typescript
const evaluate = yield* Location.BatchEvaluateGeofences(collection);

yield* evaluate({
  DevicePositionUpdates: [
    {
      DeviceId: "vehicle-1",
      Position: [-122.3493, 47.6205],
      SampleTime: new Date(),
    },
  ],
});
```

@binding

## BatchEvaluateGeofences.Request

`BatchEvaluateGeofences` request with `CollectionName` injected from the bound
resource.

## BatchGetDevicePosition

Retrieves the latest position for up to 10 devices from the tracker in one call.

Runtime binding for the `BatchGetDevicePosition` operation (IAM action
`geo:BatchGetDevicePosition`), scoped to one {@link Tracker}. Provide the implementation with
`Effect.provide(AWS.Location.BatchGetDevicePositionHttp)`.

### Reading Device Positions
**Example:** Read Several Devices at Once
```typescript
const batchGet = yield* Location.BatchGetDevicePosition(tracker);

const result = yield* batchGet({ DeviceIds: ["vehicle-1", "vehicle-2"] });
// result.DevicePositions → found positions, result.Errors → per-device failures
```

@binding

## BatchGetDevicePosition.Request

`BatchGetDevicePosition` request with `TrackerName` injected from the bound
resource.

## BatchPutGeofence

Stores up to 10 geofences in the collection in one call.

Runtime binding for the `BatchPutGeofence` operation (IAM action
`geo:BatchPutGeofence`), scoped to one {@link GeofenceCollection}. Provide the implementation with
`Effect.provide(AWS.Location.BatchPutGeofenceHttp)`.

### Managing Geofences
**Example:** Store Several Geofences at Once
```typescript
const batchPut = yield* Location.BatchPutGeofence(collection);

const result = yield* batchPut({
  Entries: [
    {
      GeofenceId: "warehouse",
      Geometry: { Circle: { Center: [-122.3493, 47.6205], Radius: 100 } },
    },
  ],
});
// result.Successes / result.Errors → per-geofence outcomes
```

@binding

## BatchPutGeofence.Request

`BatchPutGeofence` request with `CollectionName` injected from the bound
resource.

## BatchUpdateDevicePosition

Uploads position updates for up to 10 devices to the tracker (also triggers geofence evaluation for linked collections).

Runtime binding for the `BatchUpdateDevicePosition` operation (IAM action
`geo:BatchUpdateDevicePosition`), scoped to one {@link Tracker}. Provide the implementation with
`Effect.provide(AWS.Location.BatchUpdateDevicePositionHttp)`.

### Updating Device Positions
**Example:** Report Device Positions
```typescript
const updatePositions = yield* Location.BatchUpdateDevicePosition(tracker);

yield* updatePositions({
  Updates: [
    {
      DeviceId: "vehicle-1",
      Position: [-122.3493, 47.6205], // [longitude, latitude]
      SampleTime: new Date(),
    },
  ],
});
```

@binding

## BatchUpdateDevicePosition.Request

`BatchUpdateDevicePosition` request with `TrackerName` injected from the bound
resource.

## CalculateRoute

Calculates a route (distance, duration, and legs) between a departure and a destination position.

Runtime binding for the `CalculateRoute` operation (IAM action
`geo:CalculateRoute`), scoped to one {@link RouteCalculator}. Provide the implementation with
`Effect.provide(AWS.Location.CalculateRouteHttp)`.

### Calculating Routes
**Example:** Calculate a Route
```typescript
const calculateRoute = yield* Location.CalculateRoute(calculator);

const route = yield* calculateRoute({
  DeparturePosition: [-122.3493, 47.6205],
  DestinationPosition: [-122.3321, 47.6062],
});
// route.Summary.Distance, route.Summary.DurationSeconds
```

@binding

## CalculateRoute.Request

`CalculateRoute` request with `CalculatorName` injected from the bound
resource.

## CalculateRouteMatrix

Calculates the distance/duration matrix between sets of departure and destination positions.

Runtime binding for the `CalculateRouteMatrix` operation (IAM action
`geo:CalculateRouteMatrix`), scoped to one {@link RouteCalculator}. Provide the implementation with
`Effect.provide(AWS.Location.CalculateRouteMatrixHttp)`.

### Calculating Routes
**Example:** Calculate a Route Matrix
```typescript
const calculateMatrix = yield* Location.CalculateRouteMatrix(calculator);

const matrix = yield* calculateMatrix({
  DeparturePositions: [[-122.3493, 47.6205]],
  DestinationPositions: [[-122.3321, 47.6062], [-122.2015, 47.6101]],
});
// matrix.RouteMatrix[departure][destination].Distance
```

@binding

## CalculateRouteMatrix.Request

`CalculateRouteMatrix` request with `CalculatorName` injected from the bound
resource.

## CancelJob

Cancels a running Location batch metadata job.

Runtime binding for the `CancelJob` operation (IAM action
`geo:CancelJob`), account-scoped — batch jobs are created at runtime so the
grant is on `*`. Provide the implementation with
`Effect.provide(AWS.Location.CancelJobHttp)`.

### Managing Batch Jobs
**Example:** Cancel a Batch Job
```typescript
const cancelJob = yield* Location.CancelJob();

yield* cancelJob({ JobId: jobId });
```

@binding

## ForecastGeofenceEvents

Forecasts which geofences a device will enter or exit given its position and speed.

Runtime binding for the `ForecastGeofenceEvents` operation (IAM action
`geo:ForecastGeofenceEvents`), scoped to one {@link GeofenceCollection}. Provide the implementation with
`Effect.provide(AWS.Location.ForecastGeofenceEventsHttp)`.

### Evaluating Positions Against Geofences
**Example:** Forecast Upcoming Geofence Events
```typescript
const forecast = yield* Location.ForecastGeofenceEvents(collection);

const events = yield* forecast({
  DeviceState: { Position: [-122.3493, 47.6205], Speed: 20 },
  TimeHorizonMinutes: 30,
});
// events.ForecastedEvents → [{ GeofenceId, EventType, NearestDistance }, …]
```

@binding

## ForecastGeofenceEvents.Request

`ForecastGeofenceEvents` request with `CollectionName` injected from the bound
resource.

## GetDevicePosition

Retrieves a device's most recent position reported to the tracker.

Runtime binding for the `GetDevicePosition` operation (IAM action
`geo:GetDevicePosition`), scoped to one {@link Tracker}. Provide the implementation with
`Effect.provide(AWS.Location.GetDevicePositionHttp)`.

### Reading Device Positions
**Example:** Read a Device's Latest Position
```typescript
const getPosition = yield* Location.GetDevicePosition(tracker);

const latest = yield* getPosition({ DeviceId: "vehicle-1" });
// latest.Position → [longitude, latitude]
```

@binding

## GetDevicePosition.Request

`GetDevicePosition` request with `TrackerName` injected from the bound
resource.

## GetDevicePositionHistory

Retrieves the position history of a device from the tracker (positions are retained for 30 days).

Runtime binding for the `GetDevicePositionHistory` operation (IAM action
`geo:GetDevicePositionHistory`), scoped to one {@link Tracker}. Provide the implementation with
`Effect.provide(AWS.Location.GetDevicePositionHistoryHttp)`.

### Reading Device Positions
**Example:** Read a Device's Position History
```typescript
const getHistory = yield* Location.GetDevicePositionHistory(tracker);

const history = yield* getHistory({ DeviceId: "vehicle-1" });
// history.DevicePositions → chronological position samples
```

@binding

## GetDevicePositionHistory.Request

`GetDevicePositionHistory` request with `TrackerName` injected from the bound
resource.

## GetGeofence

Retrieves a geofence's geometry and status from the collection.

Runtime binding for the `GetGeofence` operation (IAM action
`geo:GetGeofence`), scoped to one {@link GeofenceCollection}. Provide the implementation with
`Effect.provide(AWS.Location.GetGeofenceHttp)`.

### Reading Geofences
**Example:** Read a Geofence
```typescript
const getGeofence = yield* Location.GetGeofence(collection);

const fence = yield* getGeofence({ GeofenceId: "warehouse" });
// fence.Status → "ACTIVE" once evaluable
```

@binding

## GetGeofence.Request

`GetGeofence` request with `CollectionName` injected from the bound
resource.

## GetJob

Retrieves the status, configuration, and error report of a Location batch metadata job.

Runtime binding for the `GetJob` operation (IAM action
`geo:GetJob`), account-scoped — batch jobs are created at runtime so the
grant is on `*`. Provide the implementation with
`Effect.provide(AWS.Location.GetJobHttp)`.

### Managing Batch Jobs
**Example:** Poll a Batch Job
```typescript
const getJob = yield* Location.GetJob();

const job = yield* getJob({ JobId: jobId });
// job.Status → "IN_PROGRESS" | "SUCCEEDED" | …
```

@binding

## GetPlace

Fetches the full details of a place by the `PlaceId` returned from a search.

Runtime binding for the `GetPlace` operation (IAM action
`geo:GetPlace`), scoped to one {@link PlaceIndex}. Provide the implementation with
`Effect.provide(AWS.Location.GetPlaceHttp)`.

### Searching Places
**Example:** Fetch Place Details
```typescript
const getPlace = yield* Location.GetPlace(index);

const place = yield* getPlace({ PlaceId: placeId });
// place.Place.Label, place.Place.Geometry.Point
```

@binding

## GetPlace.Request

`GetPlace` request with `IndexName` injected from the bound
resource.

## ListDevicePositions

Lists the latest position of every device reported to the tracker, optionally filtered by a polygon.

Runtime binding for the `ListDevicePositions` operation (IAM action
`geo:ListDevicePositions`), scoped to one {@link Tracker}. Provide the implementation with
`Effect.provide(AWS.Location.ListDevicePositionsHttp)`.

### Reading Device Positions
**Example:** List All Device Positions
```typescript
const listPositions = yield* Location.ListDevicePositions(tracker);

const page = yield* listPositions();
// page.Entries → [{ DeviceId, Position, SampleTime }, …]
```

@binding

## ListDevicePositions.Request

`ListDevicePositions` request with `TrackerName` injected from the bound
resource.

## ListGeofences

Lists the geofences stored in the collection.

Runtime binding for the `ListGeofences` operation (IAM action
`geo:ListGeofences`), scoped to one {@link GeofenceCollection}. Provide the implementation with
`Effect.provide(AWS.Location.ListGeofencesHttp)`.

### Reading Geofences
**Example:** List Geofences
```typescript
const listGeofences = yield* Location.ListGeofences(collection);

const page = yield* listGeofences();
// page.Entries → [{ GeofenceId, Geometry, Status }, …]
```

@binding

## ListGeofences.Request

`ListGeofences` request with `CollectionName` injected from the bound
resource.

## ListJobs

Lists the account's Location batch metadata jobs (e.g. batch address validation jobs).

Runtime binding for the `ListJobs` operation (IAM action
`geo:ListJobs`), account-scoped — batch jobs are created at runtime so the
grant is on `*`. Provide the implementation with
`Effect.provide(AWS.Location.ListJobsHttp)`.

### Managing Batch Jobs
**Example:** List Batch Jobs
```typescript
const listJobs = yield* Location.ListJobs();

const page = yield* listJobs();
// page.Entries → [{ JobId, Status, Action }, …]
```

@binding

## PutGeofence

Stores (creates or replaces) a single geofence geometry in the collection.

Runtime binding for the `PutGeofence` operation (IAM action
`geo:PutGeofence`), scoped to one {@link GeofenceCollection}. Provide the implementation with
`Effect.provide(AWS.Location.PutGeofenceHttp)`.

### Managing Geofences
**Example:** Store a Circular Geofence
```typescript
const putGeofence = yield* Location.PutGeofence(collection);

yield* putGeofence({
  GeofenceId: "warehouse",
  Geometry: { Circle: { Center: [-122.3493, 47.6205], Radius: 100 } },
});
```

@binding

## PutGeofence.Request

`PutGeofence` request with `CollectionName` injected from the bound
resource.

## SearchPlaceIndexForPosition

Reverse-geocodes a coordinate into the nearest addresses and places.

Runtime binding for the `SearchPlaceIndexForPosition` operation (IAM action
`geo:SearchPlaceIndexForPosition`), scoped to one {@link PlaceIndex}. Provide the implementation with
`Effect.provide(AWS.Location.SearchPlaceIndexForPositionHttp)`.

### Searching Places
**Example:** Reverse-Geocode a Coordinate
```typescript
const searchPosition = yield* Location.SearchPlaceIndexForPosition(index);

const results = yield* searchPosition({
  Position: [-122.3493, 47.6205], // [longitude, latitude]
  MaxResults: 1,
});
// results.Results[0].Place.Label → nearest address
```

@binding

## SearchPlaceIndexForPosition.Request

`SearchPlaceIndexForPosition` request with `IndexName` injected from the bound
resource.

## SearchPlaceIndexForSuggestions

Returns typeahead suggestions for a partial text query (autocomplete).

Runtime binding for the `SearchPlaceIndexForSuggestions` operation (IAM action
`geo:SearchPlaceIndexForSuggestions`), scoped to one {@link PlaceIndex}. Provide the implementation with
`Effect.provide(AWS.Location.SearchPlaceIndexForSuggestionsHttp)`.

### Searching Places
**Example:** Autocomplete a Query
```typescript
const suggest = yield* Location.SearchPlaceIndexForSuggestions(index);

const results = yield* suggest({
  Text: "coffee",
  BiasPosition: [-122.3493, 47.6205],
  MaxResults: 5,
});
// results.Results → [{ Text, PlaceId }, …]
```

@binding

## SearchPlaceIndexForSuggestions.Request

`SearchPlaceIndexForSuggestions` request with `IndexName` injected from the bound
resource.

## SearchPlaceIndexForText

Geocodes a free-form text query (address, place name, business) into ranked places with coordinates.

Runtime binding for the `SearchPlaceIndexForText` operation (IAM action
`geo:SearchPlaceIndexForText`), scoped to one {@link PlaceIndex}. Provide the implementation with
`Effect.provide(AWS.Location.SearchPlaceIndexForTextHttp)`.

### Searching Places
**Example:** Geocode an Address
```typescript
const searchText = yield* Location.SearchPlaceIndexForText(index);

const results = yield* searchText({
  Text: "Space Needle, Seattle, WA",
  MaxResults: 3,
});
// results.Results[0].Place.Geometry.Point → [longitude, latitude]
```

@binding

## SearchPlaceIndexForText.Request

`SearchPlaceIndexForText` request with `IndexName` injected from the bound
resource.

## VerifyDevicePosition

Verifies a reported device position against cellular, Wi-Fi, and IP signals to detect spoofed GPS locations.

Runtime binding for the `VerifyDevicePosition` operation (IAM action
`geo:VerifyDevicePosition`), scoped to one {@link Tracker}. Provide the implementation with
`Effect.provide(AWS.Location.VerifyDevicePositionHttp)`.

### Verifying Device Positions
**Example:** Verify a Position Against Wi-Fi Signals
```typescript
const verifyPosition = yield* Location.VerifyDevicePosition(tracker);

const verdict = yield* verifyPosition({
  DeviceState: {
    DeviceId: "vehicle-1",
    SampleTime: new Date(),
    Position: [-122.3493, 47.6205],
    WiFiAccessPoints: [{ MacAddress: "A0:EC:F9:1E:32:C1", Rss: -66 }],
  },
});
// verdict.InferredState → inferred position + accuracy
```

@binding

## VerifyDevicePosition.Request

`VerifyDevicePosition` request with `TrackerName` injected from the bound
resource.
