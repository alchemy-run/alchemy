<!-- Docs for the generated AWS.AppFlow bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelFlowExecutions

Runtime binding for `appflow:CancelFlowExecutions`.

Bind this operation to a {@link Flow} in the function's init phase to get a
callable that cancels in-progress runs of the flow — all active runs when
called with no arguments, or only the given `executionIds`. Executions that
cannot be canceled (already finished, unknown) are returned in
`invalidExecutions`. The flow name is injected automatically and
`appflow:CancelFlowExecutions` is granted on the flow. Provide the
implementation with `Effect.provide(AWS.AppFlow.CancelFlowExecutionsHttp)`.
### Running Flows
**Example:** Cancel Specific Flow Runs
```typescript
// init — bind the operation to the flow
const cancelFlowExecutions = yield* AWS.AppFlow.CancelFlowExecutions(flow);

// runtime — cancel a run by execution id
const result = yield* cancelFlowExecutions({
  executionIds: [executionId],
});
// result.invalidExecutions lists ids that could not be canceled
```

@binding

## DescribeConnectorEntity

Runtime binding for `appflow:DescribeConnectorEntity`.

Bind this operation to a {@link ConnectorProfile} in the function's init
phase to get a callable that describes one entity's fields (the data model
of a Salesforce object, a database table, etc.). The connector profile name
is injected automatically and `appflow:DescribeConnectorEntity` is granted
on the profile. Provide the implementation with
`Effect.provide(AWS.AppFlow.DescribeConnectorEntityHttp)`.
### Discovering Connector Entities
**Example:** Describe an Entity's Fields
```typescript
// init — bind the operation to the connector profile
const describeConnectorEntity =
  yield* AWS.AppFlow.DescribeConnectorEntity(profile);

// runtime — read the entity's field metadata
const result = yield* describeConnectorEntity({
  connectorEntityName: "Account",
});
// result.connectorEntityFields lists each field with its type
```

@binding

## DescribeFlowExecutionRecords

Runtime binding for `appflow:DescribeFlowExecutionRecords`.

Bind this operation to a {@link Flow} in the function's init phase to get a
callable that pages through the flow's run history — each record carries
the `executionId`, status, timing, and record counts of one run. The flow
name is injected automatically and `appflow:DescribeFlowExecutionRecords`
is granted on the flow. Provide the implementation with
`Effect.provide(AWS.AppFlow.DescribeFlowExecutionRecordsHttp)`.
### Monitoring Flow Runs
**Example:** Check the Status of the Latest Run
```typescript
// init — bind the operation to the flow
const describeFlowExecutionRecords =
  yield* AWS.AppFlow.DescribeFlowExecutionRecords(flow);

// runtime — read the most recent run
const records = yield* describeFlowExecutionRecords({ maxResults: 1 });
const latest = records.flowExecutions?.[0];
// latest?.executionStatus === "Successful"
```

@binding

## ListConnectorEntities

Runtime binding for `appflow:ListConnectorEntities`.

Bind this operation to a {@link ConnectorProfile} in the function's init
phase to get a callable that discovers the entities the connected
application exposes (e.g. Salesforce objects, database tables) — useful for
dynamic schema discovery at runtime. The connector profile name is injected
automatically and `appflow:ListConnectorEntities` is granted on the
profile. Provide the implementation with
`Effect.provide(AWS.AppFlow.ListConnectorEntitiesHttp)`.
### Discovering Connector Entities
**Example:** List the Entities Behind a Connector Profile
```typescript
// init — bind the operation to the connector profile
const listConnectorEntities =
  yield* AWS.AppFlow.ListConnectorEntities(profile);

// runtime — enumerate the connector's entities
const result = yield* listConnectorEntities();
// result.connectorEntityMap groups entities by category
```

@binding

## ResetConnectorMetadataCache

Runtime binding for `appflow:ResetConnectorMetadataCache`.

Bind this operation to a {@link ConnectorProfile} in the function's init
phase to get a callable that clears AppFlow's cached entity metadata for
the profile, so the next `ListConnectorEntities` /
`DescribeConnectorEntity` call fetches fresh metadata from the connected
application. The connector profile name is injected automatically and
`appflow:ResetConnectorMetadataCache` is granted on the profile. Provide
the implementation with
`Effect.provide(AWS.AppFlow.ResetConnectorMetadataCacheHttp)`.
### Discovering Connector Entities
**Example:** Refresh Cached Entity Metadata
```typescript
// init — bind the operation to the connector profile
const resetConnectorMetadataCache =
  yield* AWS.AppFlow.ResetConnectorMetadataCache(profile);

// runtime — drop the cache before re-listing entities
yield* resetConnectorMetadataCache();
const fresh = yield* listConnectorEntities();
```

@binding

## StartFlow

Runtime binding for `appflow:StartFlow`.

Bind this operation to a {@link Flow} in the function's init phase to get a
callable that activates the flow — for on-demand flows this triggers a
single run and returns its `executionId`; for schedule and event-triggered
flows it activates the flow. The flow name is injected automatically and
`appflow:StartFlow` is granted on the flow. Provide the implementation with
`Effect.provide(AWS.AppFlow.StartFlowHttp)`.
### Running Flows
**Example:** Start an On-Demand Flow Run from a Handler
```typescript
export default MyFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const flow = yield* AWS.AppFlow.Flow("CopyFlow", { ... });
    // init — bind the operation to the flow
    const startFlow = yield* AWS.AppFlow.StartFlow(flow);

    return {
      fetch: Effect.gen(function* () {
        // runtime — trigger a run
        const run = yield* startFlow();
        return HttpServerResponse.json({ executionId: run.executionId });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(AWS.AppFlow.StartFlowHttp)),
);
```

@binding

## StopFlow

Runtime binding for `appflow:StopFlow`.

Bind this operation to a {@link Flow} in the function's init phase to get a
callable that deactivates a schedule or event-triggered flow. On-demand
flows cannot be stopped — AppFlow rejects them with a typed
`UnsupportedOperationException`. The flow name is injected automatically
and `appflow:StopFlow` is granted on the flow. Provide the implementation
with `Effect.provide(AWS.AppFlow.StopFlowHttp)`.
### Running Flows
**Example:** Deactivate a Scheduled Flow from a Handler
```typescript
// init — bind the operation to the flow
const stopFlow = yield* AWS.AppFlow.StopFlow(flow);

// runtime — deactivate the flow
const result = yield* stopFlow();
// result.flowStatus === "Suspended"
```

@binding
