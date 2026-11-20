<!-- Docs for the generated AWS.GeoRoutes bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CalculateIsolines

Runtime binding for `geo-routes:CalculateIsolines` — compute areas
reachable within time or distance thresholds from a point (isochrones /
isodistances), e.g. "everywhere within a 30-minute drive".

geo-routes is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-routes:CalculateIsolines`. Requests and responses are raw distilled
types (`Origin` is a `[longitude, latitude]` pair).

### Calculating Isolines
Provide the `CalculateIsolinesHttp` implementation layer on the Function
effect (`.pipe(Effect.provide(AWS.GeoRoutes.CalculateIsolinesHttp))`), bind
in the init phase, then call the client at runtime.

**Example:** Calculate a 10-minute drive-time isoline
```typescript
// init
const calculateIsolines = yield* AWS.GeoRoutes.CalculateIsolines();

// runtime — coordinates are [longitude, latitude]; thresholds in seconds
const result = yield* calculateIsolines({
  Origin: [-122.339, 47.61],
  Thresholds: { Time: [600] },
  TravelMode: "Car",
});
const polygons = result.Isolines[0]?.Geometries;
```

@binding

## CalculateRouteMatrix

Runtime binding for `geo-routes:CalculateRouteMatrix` — compute travel time
and distance for all pairs of origins to destinations in one call (an
origin-destination cost matrix), e.g. rank the nearest store for each
customer.

geo-routes is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-routes:CalculateRouteMatrix`. Requests and responses are raw distilled
types (positions are `[longitude, latitude]` pairs). The matrix requires a
`RoutingBoundary` — a geometry that contains all origins and destinations,
or `{ Unbounded: true }`.

### Calculating a Route Matrix
Provide the `CalculateRouteMatrixHttp` implementation layer on the Function
effect (`.pipe(Effect.provide(AWS.GeoRoutes.CalculateRouteMatrixHttp))`),
bind in the init phase, then call the client at runtime.

**Example:** Calculate a 2x2 origin-destination matrix
```typescript
// init
const calculateRouteMatrix = yield* AWS.GeoRoutes.CalculateRouteMatrix();

// runtime — positions are [longitude, latitude]
const result = yield* calculateRouteMatrix({
  Origins: [
    { Position: [-122.339, 47.61] },
    { Position: [-122.335, 47.608] },
  ],
  Destinations: [
    { Position: [-122.201, 47.61] },
    { Position: [-122.313, 47.62] },
  ],
  RoutingBoundary: {
    Geometry: { Circle: { Center: [-122.3, 47.61], Radius: 30_000 } },
  },
});
const secondsFromFirstOriginToFirstDestination =
  result.RouteMatrix[0]?.[0]?.Duration;
```

@binding

## CalculateRoutes

Runtime binding for `geo-routes:CalculateRoutes` — compute one or more
routes between an origin and a destination, with optional waypoints, travel
mode, and traffic options.

geo-routes is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-routes:CalculateRoutes`. Requests and responses are raw distilled types
(`Origin`/`Destination` are `[longitude, latitude]` pairs).

### Calculating Routes
Provide the `CalculateRoutesHttp` implementation layer on the Function
effect (`.pipe(Effect.provide(AWS.GeoRoutes.CalculateRoutesHttp))`), bind in
the init phase, then call the client at runtime.

**Example:** Calculate a route between two points
```typescript
// init
const calculateRoutes = yield* AWS.GeoRoutes.CalculateRoutes();

// runtime — coordinates are [longitude, latitude]
const result = yield* calculateRoutes({
  Origin: [-122.339, 47.61],
  Destination: [-122.201, 47.61],
  TravelMode: "Car",
});
const distanceMeters = result.Routes?.[0]?.Summary?.Distance;
```

@binding

## OptimizeWaypoints

Runtime binding for `geo-routes:OptimizeWaypoints` — calculate the optimal
order to visit a set of waypoints, minimizing travel time or distance
(the traveling-salesman step of delivery/route planning).

geo-routes is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-routes:OptimizeWaypoints`. Requests and responses are raw distilled
types (positions are `[longitude, latitude]` pairs).

### Optimizing Waypoints
Provide the `OptimizeWaypointsHttp` implementation layer on the Function
effect (`.pipe(Effect.provide(AWS.GeoRoutes.OptimizeWaypointsHttp))`), bind
in the init phase, then call the client at runtime.

**Example:** Optimize the visiting order of two stops
```typescript
// init
const optimizeWaypoints = yield* AWS.GeoRoutes.OptimizeWaypoints();

// runtime — positions are [longitude, latitude]
const result = yield* optimizeWaypoints({
  Origin: [-122.339, 47.61],
  Destination: [-122.201, 47.61],
  Waypoints: [
    { Id: "stop-1", Position: [-122.335, 47.608] },
    { Id: "stop-2", Position: [-122.313, 47.62] },
  ],
});
const order = result.OptimizedWaypoints.map((w) => w.Id);
```

@binding

## SnapToRoads

Runtime binding for `geo-routes:SnapToRoads` — match a GPS trace (a list of
possibly-noisy trace points) to the roads most likely traveled on, e.g.
clean up vehicle telemetry before computing distance driven.

geo-routes is a standalone, pay-per-call Amazon Location API with no
resource to manage: the binding takes no arguments and grants the function
`geo-routes:SnapToRoads`. Requests and responses are raw distilled types
(positions are `[longitude, latitude]` pairs).

### Snapping GPS Traces to Roads
Provide the `SnapToRoadsHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.GeoRoutes.SnapToRoadsHttp))`), bind in the init
phase, then call the client at runtime.

**Example:** Snap a two-point GPS trace to the road network
```typescript
// init
const snapToRoads = yield* AWS.GeoRoutes.SnapToRoads();

// runtime — positions are [longitude, latitude]
const result = yield* snapToRoads({
  TracePoints: [
    { Position: [-122.339, 47.61] },
    { Position: [-122.335, 47.608] },
  ],
  TravelMode: "Car",
});
const snapped = result.SnappedTracePoints.map((p) => p.SnappedPosition);
```

@binding
