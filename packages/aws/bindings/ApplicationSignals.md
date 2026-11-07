<!-- Docs for the generated AWS.ApplicationSignals bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchGetServiceLevelObjectiveBudgetReport

Runtime binding for
`application-signals:BatchGetServiceLevelObjectiveBudgetReport`, scoped
to one {@link ServiceLevelObjective}.

Retrieves the bound SLO's error-budget report — health indicator,
attainment, and remaining budget — at the requested timestamp. Provide
the implementation with
`Effect.provide(AWS.ApplicationSignals.BatchGetServiceLevelObjectiveBudgetReportHttp)`.
### Reading SLOs
**Example:** Check the SLO's Error Budget
```typescript
// init — bind the operation to the SLO
const getBudgetReport =
  yield* AWS.ApplicationSignals.BatchGetServiceLevelObjectiveBudgetReport(slo);

// runtime — the SLO's ARN is injected as SloIds
const result = yield* getBudgetReport({ Timestamp: new Date() });
const report = result.Reports[0];
yield* Effect.log(`${report?.BudgetStatus}: ${report?.Attainment}%`);
```

@binding

## BatchGetServiceLevelObjectiveBudgetReport.Request

`BatchGetServiceLevelObjectiveBudgetReport` request with `SloIds`
injected from the bound {@link ServiceLevelObjective}.

## BatchUpdateExclusionWindows

Runtime binding for `application-signals:BatchUpdateExclusionWindows`,
scoped to one {@link ServiceLevelObjective}.

Adds or removes exclusion (maintenance) windows on the bound SLO — for
example, automation that excludes a deployment window from SLO
attainment. Provide the implementation with
`Effect.provide(AWS.ApplicationSignals.BatchUpdateExclusionWindowsHttp)`.
### Managing Exclusion Windows
**Example:** Exclude a Maintenance Window
```typescript
// init — bind the operation to the SLO
const updateExclusionWindows =
  yield* AWS.ApplicationSignals.BatchUpdateExclusionWindows(slo);

// runtime — the SLO's ARN is injected as SloIds
yield* updateExclusionWindows({
  AddExclusionWindows: [
    {
      StartTime: new Date(),
      Window: { DurationUnit: "HOUR", Duration: 2 },
      Reason: "scheduled maintenance",
    },
  ],
});
```

@binding

## BatchUpdateExclusionWindows.Request

`BatchUpdateExclusionWindows` request with `SloIds` injected from the
bound {@link ServiceLevelObjective}.

## GetService

Runtime binding for `application-signals:GetService`.

Returns information about one service discovered by Application Signals,
identified by its `KeyAttributes` (`Type`/`Name`/`Environment`). Provide
the implementation with
`Effect.provide(AWS.ApplicationSignals.GetServiceHttp)`.
### Discovering Services
**Example:** Get a Discovered Service
```typescript
// init — account-level, no resource argument
const getService = yield* AWS.ApplicationSignals.GetService();

// runtime
const result = yield* getService({
  StartTime: new Date(Date.now() - 3600_000),
  EndTime: new Date(),
  KeyAttributes: {
    Type: "Service",
    Name: "checkout-service",
    Environment: "eks:prod",
  },
});
```

@binding

## GetServiceLevelObjective

Runtime binding for `application-signals:GetServiceLevelObjective`,
scoped to one {@link ServiceLevelObjective}.

Returns the bound SLO's full configuration (SLI, goal, burn rates).
Provide the implementation with
`Effect.provide(AWS.ApplicationSignals.GetServiceLevelObjectiveHttp)`.
### Reading SLOs
**Example:** Read the Bound SLO
```typescript
// init — bind the operation to the SLO
const getSlo = yield* AWS.ApplicationSignals.GetServiceLevelObjective(slo);

// runtime — the SLO's ARN is injected automatically
const result = yield* getSlo();
yield* Effect.log(result.Slo.Goal.AttainmentGoal);
```

@binding

## ListAuditFindings

Runtime binding for `application-signals:ListAuditFindings`.

Returns audit findings — automated analysis of service behavior and root
causes (performance issues, anomalies, potential problems) for the given
audit targets. Provide the implementation with
`Effect.provide(AWS.ApplicationSignals.ListAuditFindingsHttp)`.
### Auditing Services
**Example:** List Audit Findings for a Service
```typescript
// init — account-level, no resource argument
const listAuditFindings = yield* AWS.ApplicationSignals.ListAuditFindings();

// runtime
const result = yield* listAuditFindings({
  StartTime: new Date(Date.now() - 3600_000),
  EndTime: new Date(),
  AuditTargets: [
    {
      Type: "service",
      Data: {
        Service: {
          Type: "Service",
          Name: "checkout-service",
          Environment: "eks:prod",
        },
      },
    },
  ],
});
```

@binding

## ListEntityEvents

Runtime binding for `application-signals:ListEntityEvents`.

Lists change events (deployments, configuration changes, and other
state-changing activities) for a specific entity. Provide the
implementation with
`Effect.provide(AWS.ApplicationSignals.ListEntityEventsHttp)`.
### Tracking Changes
**Example:** List an Entity's Change Events
```typescript
// init — account-level, no resource argument
const listEntityEvents = yield* AWS.ApplicationSignals.ListEntityEvents();

// runtime
const page = yield* listEntityEvents({
  Entity: {
    Type: "Service",
    Name: "checkout-service",
    Environment: "eks:prod",
  },
  StartTime: new Date(Date.now() - 24 * 3600_000),
  EndTime: new Date(),
});
```

@binding

## ListServiceDependencies

Runtime binding for `application-signals:ListServiceDependencies`.

Lists the dependencies (AWS services, resources, and third-party services)
that a discovered service's operations connect with. Provide the
implementation with
`Effect.provide(AWS.ApplicationSignals.ListServiceDependenciesHttp)`.
### Exploring the Service Topology
**Example:** List a Service's Dependencies
```typescript
// init — account-level, no resource argument
const listServiceDependencies =
  yield* AWS.ApplicationSignals.ListServiceDependencies();

// runtime
const page = yield* listServiceDependencies({
  StartTime: new Date(Date.now() - 3600_000),
  EndTime: new Date(),
  KeyAttributes: {
    Type: "Service",
    Name: "checkout-service",
    Environment: "eks:prod",
  },
});
```

@binding

## ListServiceDependents

Runtime binding for `application-signals:ListServiceDependents`.

Lists the dependents (other services, Synthetics canaries, RUM app
monitors) that invoked a discovered service during a time range. Provide
the implementation with
`Effect.provide(AWS.ApplicationSignals.ListServiceDependentsHttp)`.
### Exploring the Service Topology
**Example:** List a Service's Dependents
```typescript
// init — account-level, no resource argument
const listServiceDependents =
  yield* AWS.ApplicationSignals.ListServiceDependents();

// runtime
const page = yield* listServiceDependents({
  StartTime: new Date(Date.now() - 3600_000),
  EndTime: new Date(),
  KeyAttributes: {
    Type: "Service",
    Name: "checkout-service",
    Environment: "eks:prod",
  },
});
```

@binding

## ListServiceLevelObjectiveExclusionWindows

Runtime binding for
`application-signals:ListServiceLevelObjectiveExclusionWindows`, scoped
to one {@link ServiceLevelObjective}.

Lists the exclusion (maintenance) windows configured on the bound SLO.
Provide the implementation with
`Effect.provide(AWS.ApplicationSignals.ListServiceLevelObjectiveExclusionWindowsHttp)`.
### Managing Exclusion Windows
**Example:** List the SLO's Exclusion Windows
```typescript
// init — bind the operation to the SLO
const listExclusionWindows =
  yield* AWS.ApplicationSignals.ListServiceLevelObjectiveExclusionWindows(slo);

// runtime — the SLO's ARN is injected as Id
const page = yield* listExclusionWindows();
yield* Effect.log(`${page.ExclusionWindows.length} windows`);
```

@binding

## ListServiceLevelObjectiveExclusionWindows.Request

`ListServiceLevelObjectiveExclusionWindows` request with `Id` injected
from the bound {@link ServiceLevelObjective}.

## ListServiceLevelObjectives

Runtime binding for `application-signals:ListServiceLevelObjectives`.

Lists the service level objectives in this account, optionally filtered by
service key attributes, operation name, or dependency config. Provide the
implementation with
`Effect.provide(AWS.ApplicationSignals.ListServiceLevelObjectivesHttp)`.
### Listing Service Level Objectives
**Example:** List All SLOs
```typescript
// init — account-level, no resource argument
const listSlos = yield* AWS.ApplicationSignals.ListServiceLevelObjectives();

// runtime
const page = yield* listSlos({});
for (const slo of page.SloSummaries) {
  yield* Effect.log(`${slo.Name}: ${slo.Arn}`);
}
```

@binding

## ListServiceOperations

Runtime binding for `application-signals:ListServiceOperations`.

Lists the operations of a discovered service that were invoked during a
time range. Provide the implementation with
`Effect.provide(AWS.ApplicationSignals.ListServiceOperationsHttp)`.
### Exploring the Service Topology
**Example:** List a Service's Operations
```typescript
// init — account-level, no resource argument
const listServiceOperations =
  yield* AWS.ApplicationSignals.ListServiceOperations();

// runtime
const page = yield* listServiceOperations({
  StartTime: new Date(Date.now() - 3600_000),
  EndTime: new Date(),
  KeyAttributes: {
    Type: "Service",
    Name: "checkout-service",
    Environment: "eks:prod",
  },
});
```

@binding

## ListServiceStates

Runtime binding for `application-signals:ListServiceStates`.

Returns the last deployment and other change states of discovered
services — visibility into recent changes for troubleshooting and change
correlation. Provide the implementation with
`Effect.provide(AWS.ApplicationSignals.ListServiceStatesHttp)`.
### Tracking Changes
**Example:** List Recent Service States
```typescript
// init — account-level, no resource argument
const listServiceStates = yield* AWS.ApplicationSignals.ListServiceStates();

// runtime
const page = yield* listServiceStates({
  StartTime: new Date(Date.now() - 24 * 3600_000),
  EndTime: new Date(),
});
```

@binding

## ListServices

Runtime binding for `application-signals:ListServices`.

Lists the services discovered by Application Signals during a time range.
Provide the implementation with
`Effect.provide(AWS.ApplicationSignals.ListServicesHttp)`.
### Discovering Services
**Example:** List Discovered Services
```typescript
// init — account-level, no resource argument
const listServices = yield* AWS.ApplicationSignals.ListServices();

// runtime
const page = yield* listServices({
  StartTime: new Date(Date.now() - 3600_000),
  EndTime: new Date(),
});
for (const service of page.ServiceSummaries) {
  yield* Effect.log(service.KeyAttributes?.Name);
}
```

@binding
