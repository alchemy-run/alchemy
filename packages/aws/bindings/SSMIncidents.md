<!-- Docs for the generated AWS.SSMIncidents bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchGetIncidentFindings

Runtime binding for `ssm-incidents:BatchGetIncidentFindings`.

Returns the details of the findings correlated with an incident — the
CodeDeploy deployment or CloudFormation stack update suspected of causing
it. Findings live under runtime incident-record ARNs, so the deploy-time
grant is account-level (`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.BatchGetIncidentFindingsHttp)`.
### Findings
**Example:** Read Finding Details
```typescript
// init
const batchGetIncidentFindings = yield* AWS.SSMIncidents.BatchGetIncidentFindings();

// runtime
const { findings } = yield* batchGetIncidentFindings({
  incidentRecordArn,
  findingIds,
});
```

@binding

## CreateTimelineEvent

Runtime binding for `ssm-incidents:CreateTimelineEvent`.

Adds a custom event to an incident's timeline — automation can annotate the
incident as it works (diagnosis steps, mitigation actions, links). Timeline
events live under runtime incident-record ARNs, so the deploy-time grant is
account-level (`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.CreateTimelineEventHttp)`.
### Timeline Events
**Example:** Annotate An Incident
```typescript
// init
const createTimelineEvent = yield* AWS.SSMIncidents.CreateTimelineEvent();

// runtime
const { eventId } = yield* createTimelineEvent({
  incidentRecordArn,
  eventTime: new Date(),
  eventType: "Custom Event",
  eventData: JSON.stringify({ note: "traffic shifted to us-west-2" }),
});
```

@binding

## DeleteIncidentRecord

Runtime binding for `ssm-incidents:DeleteIncidentRecord`.

Deletes an incident record (idempotent — deleting a record that does not
exist succeeds). Incident-record ARNs only exist at runtime, so the
deploy-time grant is account-level (`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.DeleteIncidentRecordHttp)`.
### Updating Incident Records
**Example:** Delete An Incident Record
```typescript
// init
const deleteIncidentRecord = yield* AWS.SSMIncidents.DeleteIncidentRecord();

// runtime
yield* deleteIncidentRecord({ arn: incidentRecordArn });
```

@binding

## DeleteTimelineEvent

Runtime binding for `ssm-incidents:DeleteTimelineEvent`.

Deletes a custom timeline event from an incident (idempotent — deleting an
event that does not exist succeeds). Timeline events live under runtime
incident-record ARNs, so the deploy-time grant is account-level
(`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.DeleteTimelineEventHttp)`.
### Timeline Events
**Example:** Delete A Timeline Event
```typescript
// init
const deleteTimelineEvent = yield* AWS.SSMIncidents.DeleteTimelineEvent();

// runtime
yield* deleteTimelineEvent({ incidentRecordArn, eventId });
```

@binding

## GetIncidentRecord

Runtime binding for `ssm-incidents:GetIncidentRecord`.

Returns the details of an incident record — title, impact, status, chat
channel, and notification targets. Incident-record ARNs only exist at
runtime, so the deploy-time grant is account-level (`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.GetIncidentRecordHttp)`.
### Reading Incident Records
**Example:** Read An Incident
```typescript
// init
const getIncidentRecord = yield* AWS.SSMIncidents.GetIncidentRecord();

// runtime
const { incidentRecord } = yield* getIncidentRecord({ arn: incidentRecordArn });
```

@binding

## GetTimelineEvent

Runtime binding for `ssm-incidents:GetTimelineEvent`.

Returns one timeline event of an incident by event id. Timeline events live
under runtime incident-record ARNs, so the deploy-time grant is
account-level (`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.GetTimelineEventHttp)`.
### Timeline Events
**Example:** Read A Timeline Event
```typescript
// init
const getTimelineEvent = yield* AWS.SSMIncidents.GetTimelineEvent();

// runtime
const { event } = yield* getTimelineEvent({ incidentRecordArn, eventId });
```

@binding

## ListIncidentFindings

Runtime binding for `ssm-incidents:ListIncidentFindings`.

Lists the findings (CodeDeploy deployments and CloudFormation stack updates
around the incident's start time) that Incident Manager correlated with an
incident. Findings live under runtime incident-record ARNs, so the
deploy-time grant is account-level (`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.ListIncidentFindingsHttp)`.
### Findings
**Example:** List An Incident's Findings
```typescript
// init
const listIncidentFindings = yield* AWS.SSMIncidents.ListIncidentFindings();

// runtime
const { findings } = yield* listIncidentFindings({ incidentRecordArn });
```

@binding

## ListIncidentRecords

Runtime binding for `ssm-incidents:ListIncidentRecords`.

Lists the incident records in the account — the incidents started from any
response plan. Incident records are runtime entities (their ARNs embed the
response-plan name and a UUID that only exist once an incident starts), so
the deploy-time grant is account-level (`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.ListIncidentRecordsHttp)`.
### Reading Incident Records
**Example:** List Open Incidents
```typescript
// init
const listIncidentRecords = yield* AWS.SSMIncidents.ListIncidentRecords();

// runtime
const { incidentRecordSummaries } = yield* listIncidentRecords({
  filters: [{ key: "status", condition: { equals: { stringValues: ["OPEN"] } } }],
});
```

@binding

## ListRelatedItems

Runtime binding for `ssm-incidents:ListRelatedItems`.

Lists the related items of an incident — attached metrics, runbook
executions, parent tickets, and links. Related items live under runtime
incident-record ARNs, so the deploy-time grant is account-level
(`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.ListRelatedItemsHttp)`.
### Related Items
**Example:** List An Incident's Related Items
```typescript
// init
const listRelatedItems = yield* AWS.SSMIncidents.ListRelatedItems();

// runtime
const { relatedItems } = yield* listRelatedItems({ incidentRecordArn });
```

@binding

## ListTimelineEvents

Runtime binding for `ssm-incidents:ListTimelineEvents`.

Lists the timeline events of an incident, with optional filters and sorting.
Timeline events live under runtime incident-record ARNs, so the deploy-time
grant is account-level (`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.ListTimelineEventsHttp)`.
### Timeline Events
**Example:** List An Incident's Timeline
```typescript
// init
const listTimelineEvents = yield* AWS.SSMIncidents.ListTimelineEvents();

// runtime
const { eventSummaries } = yield* listTimelineEvents({
  incidentRecordArn,
  sortBy: "EVENT_TIME",
  sortOrder: "DESCENDING",
});
```

@binding

## StartIncident

Runtime binding for `ssm-incidents:StartIncident`.

Starts an incident from the bound {@link ResponsePlan} — Incident Manager
creates the incident record, engages the plan's contacts, posts to its
chat channel, and runs its Automation runbooks. The response plan ARN is
injected from the binding; pass `triggerDetails` to record what fired the
incident.
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.StartIncidentHttp)`.
### Starting Incidents
**Example:** Open An Incident From An Alarm Handler
```typescript
// init — bind the operation to the response plan
const startIncident = yield* AWS.SSMIncidents.StartIncident(plan);

// runtime
const { incidentRecordArn } = yield* startIncident({
  title: "checkout p99 breach",
  impact: 2,
  triggerDetails: {
    source: "custom.checkout-monitor",
    timestamp: new Date(),
  },
});
```

@binding

## UpdateIncidentRecord

Runtime binding for `ssm-incidents:UpdateIncidentRecord`.

Updates the details of an incident record — retitle, change impact, or
resolve the incident by setting `status: "RESOLVED"`. Incident-record ARNs
only exist at runtime, so the deploy-time grant is account-level
(`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.UpdateIncidentRecordHttp)`.
### Updating Incident Records
**Example:** Resolve An Incident
```typescript
// init
const updateIncidentRecord = yield* AWS.SSMIncidents.UpdateIncidentRecord();

// runtime
yield* updateIncidentRecord({ arn: incidentRecordArn, status: "RESOLVED" });
```

@binding

## UpdateRelatedItems

Runtime binding for `ssm-incidents:UpdateRelatedItems`.

Attaches or removes a related item on an incident — link the dashboard,
ticket, or runbook execution your automation is working from. Related items
live under runtime incident-record ARNs, so the deploy-time grant is
account-level (`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.UpdateRelatedItemsHttp)`.
### Related Items
**Example:** Attach A Link To An Incident
```typescript
// init
const updateRelatedItems = yield* AWS.SSMIncidents.UpdateRelatedItems();

// runtime
yield* updateRelatedItems({
  incidentRecordArn,
  relatedItemsUpdate: {
    itemToAdd: {
      title: "Grafana dashboard",
      identifier: { type: "OTHER", value: { url: "https://grafana.example.com/d/abc" } },
    },
  },
});
```

@binding

## UpdateTimelineEvent

Runtime binding for `ssm-incidents:UpdateTimelineEvent`.

Updates a timeline event's time, type, data, or references. Timeline events
live under runtime incident-record ARNs, so the deploy-time grant is
account-level (`Resource: "*"`).
Provide the implementation with
`Effect.provide(AWS.SSMIncidents.UpdateTimelineEventHttp)`.
### Timeline Events
**Example:** Amend A Timeline Event
```typescript
// init
const updateTimelineEvent = yield* AWS.SSMIncidents.UpdateTimelineEvent();

// runtime
yield* updateTimelineEvent({
  incidentRecordArn,
  eventId,
  eventData: JSON.stringify({ note: "mitigation confirmed" }),
});
```

@binding
