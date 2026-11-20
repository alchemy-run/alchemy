<!-- Docs for the generated AWS.FraudDetector bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DeleteEvent

Delete a stored event from Amazon Fraud Detector — the effectful erasure
call made from a deployed Lambda or Task, e.g. to honor a data-deletion
request. Set `deleteAuditHistory` to also remove the event's prediction
history.

### Deleting Stored Events
Provide the `DeleteEventHttp` implementation layer on the Function effect,
bind the event type in the init phase, then call the returned client at
runtime. The binding grants `frauddetector:DeleteEvent` on the event type
and injects its `eventTypeName` automatically.

**Example:** Delete from a Lambda
```typescript
// init
const deleteEvent = yield* FraudDetector.DeleteEvent(eventType);

return {
  fetch: Effect.gen(function* () {
    // runtime
    yield* deleteEvent({ eventId: "order-123", deleteAuditHistory: true });
    return HttpServerResponse.json({ ok: true });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(FraudDetector.DeleteEventHttp))
```

@binding

## DeleteEvent.Request

The `eventTypeName` is injected by the binding from the bound event type;
the `eventId` and optional `deleteAuditHistory` flag remain.

## DeleteEventsByEventType

Start an asynchronous bulk delete of ALL events stored for a bound Amazon
Fraud Detector event type — the effectful cleanup call (e.g. a data-privacy
purge) made from a deployed Lambda or Task. Track progress with the
companion `GetDeleteEventsByEventTypeStatus` binding.

### Purging Stored Events
Provide the `DeleteEventsByEventTypeHttp` implementation layer on the
Function effect, bind the event type in the init phase, then call the
returned client at runtime. The binding grants
`frauddetector:DeleteEventsByEventType` on the event type and injects its
`eventTypeName` automatically.

**Example:** Purge from a Lambda
```typescript
// init
const deleteEventsByEventType =
  yield* FraudDetector.DeleteEventsByEventType(eventType);
const getDeleteStatus =
  yield* FraudDetector.GetDeleteEventsByEventTypeStatus(eventType);

return {
  fetch: Effect.gen(function* () {
    // runtime
    yield* deleteEventsByEventType({});
    const { eventsDeletionStatus } = yield* getDeleteStatus({});
    return HttpServerResponse.json({ status: eventsDeletionStatus });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(Layer.mergeAll(
//   FraudDetector.DeleteEventsByEventTypeHttp,
//   FraudDetector.GetDeleteEventsByEventTypeStatusHttp,
// )))
```

@binding

## DeleteEventsByEventType.Request

The `eventTypeName` is injected by the binding from the bound event type;
the request carries nothing else.

## GetDeleteEventsByEventTypeStatus

Check the status of an asynchronous bulk event delete started by
`DeleteEventsByEventType` on a bound Amazon Fraud Detector event type — the
effectful status poll made from a deployed Lambda or Task.

### Purging Stored Events
Provide the `GetDeleteEventsByEventTypeStatusHttp` implementation layer on
the Function effect, bind the event type in the init phase, then call the
returned client at runtime. The binding grants
`frauddetector:GetDeleteEventsByEventTypeStatus` on the event type and
injects its `eventTypeName` automatically.

**Example:** Poll from a Lambda
```typescript
// init
const getDeleteStatus =
  yield* FraudDetector.GetDeleteEventsByEventTypeStatus(eventType);

return {
  fetch: Effect.gen(function* () {
    // runtime
    const { eventsDeletionStatus } = yield* getDeleteStatus({});
    return HttpServerResponse.json({ status: eventsDeletionStatus });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(FraudDetector.GetDeleteEventsByEventTypeStatusHttp))
```

@binding

## GetDeleteEventsByEventTypeStatus.Request

The `eventTypeName` is injected by the binding from the bound event type;
the request carries nothing else.

## GetEvent

Read a stored event (its entities and variable values) back from Amazon
Fraud Detector — the effectful lookup call made from a deployed Lambda or
Task. Events are stored by `SendEvent` or by predictions on an event type
with ingestion enabled.

### Reading Stored Events
Provide the `GetEventHttp` implementation layer on the Function effect,
bind the event type in the init phase, then call the returned client at
runtime. The binding grants `frauddetector:GetEvent` on the event type and
injects its `eventTypeName` automatically.

**Example:** Read from a Lambda
```typescript
// init
const getEvent = yield* FraudDetector.GetEvent(eventType);

return {
  fetch: Effect.gen(function* () {
    // runtime
    const { event } = yield* getEvent({ eventId: "order-123" });
    return HttpServerResponse.json({ variables: event?.eventVariables });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(FraudDetector.GetEventHttp))
```

@binding

## GetEvent.Request

The `eventTypeName` is injected by the binding from the bound event type;
only the `eventId` remains.

## GetEventPrediction

Submit an event to a bound Amazon Fraud Detector detector and receive the
real-time model scores and rule outcomes for it — the effectful prediction
call made from a deployed Lambda or Task.

### Scoring Events
Provide the `GetEventPredictionHttp` implementation layer on the Function
effect, bind the detector in the init phase, then call the returned client
at runtime. The binding grants `frauddetector:GetEventPrediction` on the
detector and injects its `detectorId` automatically.

**Example:** Predict from a Lambda
```typescript
// init
const getEventPrediction = yield* FraudDetector.GetEventPrediction(detector);

return {
  fetch: Effect.gen(function* () {
    // runtime
    const { ruleResults } = yield* getEventPrediction({
      eventId: "order-123",
      eventTypeName: "purchase",
      eventTimestamp: new Date().toISOString(),
      entities: [{ entityType: "customer", entityId: "cust-1" }],
      eventVariables: { email: "fraud@example.com", ip: "1.2.3.4" },
    });
    const outcomes = ruleResults?.flatMap((r) => r.outcomes ?? []);
    return HttpServerResponse.json({ outcomes });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(FraudDetector.GetEventPredictionHttp))
```

@binding

## GetEventPrediction.Request

The `detectorId` is injected by the binding from the bound detector;
everything else (the event id, timestamp, entities, and variable values) is
the raw distilled request. Pin `detectorVersionId` to evaluate a specific
version; omit it to use the detector's `ACTIVE` version.

## GetEventPredictionMetadata

Read the full evaluation details of a past prediction made by a bound
Amazon Fraud Detector detector — the variables, rule evaluations, and model
scores recorded for the prediction — the effectful audit call made from a
deployed Lambda or Task.

### Auditing Predictions
Provide the `GetEventPredictionMetadataHttp` implementation layer on the
Function effect, bind the detector in the init phase, then call the
returned client at runtime. The binding grants
`frauddetector:GetEventPredictionMetadata` on the detector and injects its
`detectorId` automatically. Find `predictionTimestamp` values via the
`ListEventPredictions` binding.

**Example:** Audit from a Lambda
```typescript
// init
const getPredictionMetadata =
  yield* FraudDetector.GetEventPredictionMetadata(detector);

return {
  fetch: Effect.gen(function* () {
    // runtime
    const metadata = yield* getPredictionMetadata({
      eventId: "order-123",
      eventTypeName: "purchase",
      detectorVersionId: "1",
      predictionTimestamp: "2026-01-01T00:00:00Z",
    });
    return HttpServerResponse.json({ rules: metadata.rules });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(FraudDetector.GetEventPredictionMetadataHttp))
```

@binding

## GetEventPredictionMetadata.Request

The `detectorId` is injected by the binding from the bound detector; the
caller supplies the event id, event type, detector version, and the
prediction timestamp (as returned by `ListEventPredictions`).

## GetListElements

Read the elements of a bound Amazon Fraud Detector list — the effectful
lookup call made from a deployed Lambda or Task, e.g. to check an incoming
value against a deny-list outside of a detector evaluation.

Elements decode as sensitive values (`string | Redacted<string>`); unwrap
with `Redacted.value` where needed.

### Reading List Elements
Provide the `GetListElementsHttp` implementation layer on the Function
effect, bind the list in the init phase, then call the returned client at
runtime. The binding grants `frauddetector:GetListElements` on the list and
injects its `name` automatically.

**Example:** Read from a Lambda
```typescript
// init
const getListElements = yield* FraudDetector.GetListElements(blockedIps);

return {
  fetch: Effect.gen(function* () {
    // runtime
    const { elements } = yield* getListElements({});
    return HttpServerResponse.json({ count: elements?.length ?? 0 });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(FraudDetector.GetListElementsHttp))
```

@binding

## GetListElements.Request

The list `name` is injected by the binding from the bound list; only the
pagination controls remain.

## SendEvent

Store an event in Amazon Fraud Detector without generating a prediction —
the effectful ingestion call made from a deployed Lambda or Task. Stored
events build the historical dataset used to train models and can be
labeled later via `UpdateEventLabel`. The bound event type must have
`eventIngestion: "ENABLED"`.

### Ingesting Events
Provide the `SendEventHttp` implementation layer on the Function effect,
bind the event type in the init phase, then call the returned client at
runtime. The binding grants `frauddetector:SendEvent` on the event type
and injects its `eventTypeName` automatically.

**Example:** Ingest from a Lambda
```typescript
// init
const sendEvent = yield* FraudDetector.SendEvent(eventType);

return {
  fetch: Effect.gen(function* () {
    // runtime
    yield* sendEvent({
      eventId: "order-123",
      eventTimestamp: new Date().toISOString(),
      entities: [{ entityType: "customer", entityId: "cust-1" }],
      eventVariables: { email: "buyer@example.com", ip: "1.2.3.4" },
    });
    return HttpServerResponse.json({ ok: true });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(FraudDetector.SendEventHttp))
```

@binding

## SendEvent.Request

The `eventTypeName` is injected by the binding from the bound event type;
everything else (the event id, timestamp, entities, variable values, and
optional label) is the raw distilled request.

## UpdateEventLabel

Label a stored event in Amazon Fraud Detector — the effectful feedback
call made from a deployed Lambda or Task when ground truth arrives (e.g. a
chargeback confirms fraud). Labeled events improve future model training.

### Labeling Stored Events
Provide the `UpdateEventLabelHttp` implementation layer on the Function
effect, bind the event type in the init phase, then call the returned
client at runtime. The binding grants `frauddetector:UpdateEventLabel` on
the event type and injects its `eventTypeName` automatically.

**Example:** Label from a Lambda
```typescript
// init
const updateEventLabel = yield* FraudDetector.UpdateEventLabel(eventType);

return {
  fetch: Effect.gen(function* () {
    // runtime — a chargeback arrived for this order
    yield* updateEventLabel({
      eventId: "order-123",
      assignedLabel: "fraud",
      labelTimestamp: new Date().toISOString(),
    });
    return HttpServerResponse.json({ ok: true });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(FraudDetector.UpdateEventLabelHttp))
```

@binding

## UpdateEventLabel.Request

The `eventTypeName` is injected by the binding from the bound event type;
the `eventId`, `assignedLabel`, and `labelTimestamp` remain. The label must
be one of the labels associated with the event type.

## UpdateList

Mutate the elements of a bound Amazon Fraud Detector list at runtime — the
effectful write call made from a deployed Lambda or Task, e.g. to append a
newly-confirmed fraudulent IP to a deny-list the detector's rules reference.

Note that the `List` resource reconciles `elements` declaratively on every
deploy (a `REPLACE` update), so elements appended at runtime are removed by
the next deploy unless they are also added to the resource's props.

### Updating List Elements
Provide the `UpdateListHttp` implementation layer on the Function effect,
bind the list in the init phase, then call the returned client at runtime.
The binding grants `frauddetector:UpdateList` on the list and injects its
`name` automatically.

**Example:** Append from a Lambda
```typescript
// init
const updateList = yield* FraudDetector.UpdateList(blockedIps);

return {
  fetch: Effect.gen(function* () {
    // runtime
    yield* updateList({ elements: ["192.0.2.44"], updateMode: "APPEND" });
    return HttpServerResponse.json({ ok: true });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(FraudDetector.UpdateListHttp))
```

@binding

## UpdateList.Request

The list `name` is injected by the binding from the bound list; the caller
supplies the elements and the `updateMode` (`APPEND`, `REMOVE`, or
`REPLACE`).
