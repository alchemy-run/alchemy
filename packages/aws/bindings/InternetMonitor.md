<!-- Docs for the generated AWS.InternetMonitor bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetHealthEvent

Runtime binding for `internetmonitor:GetHealthEvent` — read the full
detail (impacted locations, availability/performance measurements, impact
type) of one health event on the bound {@link Monitor}; the monitor name
is injected automatically.

Provide `InternetMonitor.GetHealthEventHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Health Events
**Example:** Read a Health Event by Id
```typescript
// init — grants internetmonitor:GetHealthEvent on the monitor
const getHealthEvent = yield* AWS.InternetMonitor.GetHealthEvent(monitor);

// runtime
const event = yield* getHealthEvent({ EventId: eventId });
const locations = event.ImpactedLocations;
```

@binding

## GetInternetEvent

Runtime binding for `internetmonitor:GetInternetEvent` — read the detail
(impacted client location, start/end time, type, status) of one global
internet event from the outages map Internet Monitor publishes for all
AWS customers. Internet events are account-level; no monitor is required.

Provide `InternetMonitor.GetInternetEventHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Internet Events
**Example:** Read an Internet Event by Id
```typescript
// init — grants internetmonitor:GetInternetEvent
const getInternetEvent = yield* AWS.InternetMonitor.GetInternetEvent();

// runtime
const event = yield* getInternetEvent({ EventId: eventId });
const location = event.ClientLocation;
```

@binding

## GetQueryResults

Runtime binding for `internetmonitor:GetQueryResults` — fetch the result
rows of a `SUCCEEDED` query on the bound {@link Monitor}; the monitor name
is injected automatically.

Provide `InternetMonitor.GetQueryResultsHttp` on the hosting Lambda
Function to satisfy the requirement.
### Querying Measurements
**Example:** Read Query Results
```typescript
// init — grants internetmonitor:GetQueryResults on the monitor
const getQueryResults = yield* AWS.InternetMonitor.GetQueryResults(monitor);

// runtime
const { Fields, Data } = yield* getQueryResults({ QueryId: queryId });
```

@binding

## GetQueryStatus

Runtime binding for `internetmonitor:GetQueryStatus` — check whether a
query started on the bound {@link Monitor} is `QUEUED`, `RUNNING`,
`SUCCEEDED`, `FAILED`, or `CANCELED`; the monitor name is injected
automatically.

Provide `InternetMonitor.GetQueryStatusHttp` on the hosting Lambda
Function to satisfy the requirement.
### Querying Measurements
**Example:** Poll a Query Until It Completes
```typescript
// init — grants internetmonitor:GetQueryStatus on the monitor
const getQueryStatus = yield* AWS.InternetMonitor.GetQueryStatus(monitor);

// runtime
const { Status } = yield* getQueryStatus({ QueryId: queryId }).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("2 seconds"),
    until: (r) => r.Status !== "QUEUED" && r.Status !== "RUNNING",
    times: 10,
  }),
);
```

@binding

## ListHealthEvents

Runtime binding for `internetmonitor:ListHealthEvents` — list the health
events Internet Monitor created for the bound {@link Monitor}; the monitor
name is injected automatically.

Provide `InternetMonitor.ListHealthEventsHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Health Events
**Example:** List Active Health Events
```typescript
// init — grants internetmonitor:ListHealthEvents on the monitor
const listHealthEvents = yield* AWS.InternetMonitor.ListHealthEvents(monitor);

// runtime
const { HealthEvents } = yield* listHealthEvents({ EventStatus: "ACTIVE" });
```

@binding

## ListInternetEvents

Runtime binding for `internetmonitor:ListInternetEvents` — list the global
internet events (performance or availability issues at client locations)
from the outages map Internet Monitor publishes for all AWS customers.
Internet events are account-level; no monitor is required.

Provide `InternetMonitor.ListInternetEventsHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Internet Events
**Example:** List Active Internet Events
```typescript
// init — grants internetmonitor:ListInternetEvents
const listInternetEvents = yield* AWS.InternetMonitor.ListInternetEvents();

// runtime
const { InternetEvents } = yield* listInternetEvents({
  EventStatus: "ACTIVE",
});
```

@binding

## StartQuery

Runtime binding for `internetmonitor:StartQuery` — start a query against
the bound {@link Monitor}'s measurement data with the Internet Monitor
query interface; the monitor name is injected automatically.

Provide `InternetMonitor.StartQueryHttp` on the hosting Lambda Function to
satisfy the requirement.
### Querying Measurements
**Example:** Start a Measurements Query
```typescript
// init — grants internetmonitor:StartQuery on the monitor
const startQuery = yield* AWS.InternetMonitor.StartQuery(monitor);

// runtime
const { QueryId } = yield* startQuery({
  StartTime: new Date(Date.now() - 3_600_000),
  EndTime: new Date(),
  QueryType: "MEASUREMENTS",
});
```

@binding

## StopQuery

Runtime binding for `internetmonitor:StopQuery` — cancel an in-progress
query on the bound {@link Monitor}; the monitor name is injected
automatically.

Provide `InternetMonitor.StopQueryHttp` on the hosting Lambda Function to
satisfy the requirement.
### Querying Measurements
**Example:** Cancel a Running Query
```typescript
// init — grants internetmonitor:StopQuery on the monitor
const stopQuery = yield* AWS.InternetMonitor.StopQuery(monitor);

// runtime
yield* stopQuery({ QueryId: queryId });
```

@binding
