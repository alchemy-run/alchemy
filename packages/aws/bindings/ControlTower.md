<!-- Docs for the generated AWS.ControlTower bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetBaseline

Runtime binding for `controltower:GetBaseline`.

An account-level operation that reads one entry of the Control Tower
baseline catalog by its ARN — its name and description. Provide the
implementation with `Effect.provide(AWS.ControlTower.GetBaselineHttp)`.
### Browsing the Baseline Catalog
**Example:** Read a Baseline's Details
```typescript
// init — account-level binding takes no resource
const getBaseline = yield* AWS.ControlTower.GetBaseline();

// runtime
const baseline = yield* getBaseline({ baselineIdentifier: baselineArn });
console.log(baseline.name, baseline.description);
```

@binding

## GetBaselineOperation

Runtime binding for `controltower:GetBaselineOperation`.

An account-level operation that reads the status of an asynchronous
baseline operation (`ENABLE_BASELINE`, `DISABLE_BASELINE`,
`UPDATE_ENABLED_BASELINE`, `RESET_ENABLED_BASELINE`). Pair it with
{@link ResetEnabledBaseline} to poll a drift-remediation run to
completion. Provide the implementation with
`Effect.provide(AWS.ControlTower.GetBaselineOperationHttp)`.
### Polling Asynchronous Operations
**Example:** Poll a Baseline Operation
```typescript
// init — account-level binding takes no resource
const getBaselineOperation = yield* AWS.ControlTower.GetBaselineOperation();

// runtime
const { baselineOperation } = yield* getBaselineOperation({
  operationIdentifier,
});
console.log(baselineOperation.status);
```

@binding

## GetControlOperation

Runtime binding for `controltower:GetControlOperation`.

An account-level operation that reads the status of an asynchronous
control operation (`ENABLE_CONTROL`, `DISABLE_CONTROL`,
`UPDATE_ENABLED_CONTROL`, `RESET_ENABLED_CONTROL`). Pair it with
{@link ResetEnabledControl} to poll a drift-remediation run to
completion. Provide the implementation with
`Effect.provide(AWS.ControlTower.GetControlOperationHttp)`.
### Polling Asynchronous Operations
**Example:** Poll a Control Operation
```typescript
// init — account-level binding takes no resource
const getControlOperation = yield* AWS.ControlTower.GetControlOperation();

// runtime
const { controlOperation } = yield* getControlOperation({
  operationIdentifier,
});
console.log(controlOperation.status);
```

@binding

## GetEnabledBaseline

Runtime binding for `controltower:GetEnabledBaseline`.

Bind this operation to an {@link EnabledBaseline} to read the
enablement's live status, drift status, and parameters from inside a
function runtime. Provide the implementation with
`Effect.provide(AWS.ControlTower.GetEnabledBaselineHttp)`.
### Inspecting an Enabled Baseline
**Example:** Read the Enabled Baseline's Status
```typescript
// init — bind the operation to the enabled baseline
const getEnabledBaseline = yield* AWS.ControlTower.GetEnabledBaseline(ouBaseline);

// runtime
const { enabledBaselineDetails } = yield* getEnabledBaseline();
console.log(enabledBaselineDetails?.statusSummary.status);
```

@binding

## GetEnabledControl

Runtime binding for `controltower:GetEnabledControl`.

Bind this operation to an {@link EnabledControl} to read the enablement's
live status, drift status, and parameters from inside a function runtime.
Useful for drift-monitoring functions that alert when a guardrail drifts.
Provide the implementation with
`Effect.provide(AWS.ControlTower.GetEnabledControlHttp)`.
### Inspecting an Enabled Control
**Example:** Read the Enabled Control's Drift Status
```typescript
// init — bind the operation to the enabled control
const getEnabledControl = yield* AWS.ControlTower.GetEnabledControl(guardrail);

// runtime
const { enabledControlDetails } = yield* getEnabledControl();
console.log(enabledControlDetails.driftStatusSummary?.driftStatus);
```

@binding

## GetLandingZone

Runtime binding for `controltower:GetLandingZone`.

An account-level operation that reads the landing zone's version, status,
drift status, and manifest by its ARN (discovered via
{@link ListLandingZones}). Useful for drift-monitoring functions that
alert when the landing zone drifts out of sync. Provide the
implementation with `Effect.provide(AWS.ControlTower.GetLandingZoneHttp)`.
### Inspecting the Landing Zone
**Example:** Read the Landing Zone's Drift Status
```typescript
// init — account-level binding takes no resource
const getLandingZone = yield* AWS.ControlTower.GetLandingZone();

// runtime
const { landingZone } = yield* getLandingZone({
  landingZoneIdentifier: arn,
});
console.log(landingZone.driftStatus?.status);
```

@binding

## GetLandingZoneOperation

Runtime binding for `controltower:GetLandingZoneOperation`.

An account-level operation that reads the status of an asynchronous
landing zone operation (`CREATE`, `UPDATE`, `DELETE`, `RESET`). Pair it
with {@link ResetLandingZone} to poll a drift-remediation run to
completion. Provide the implementation with
`Effect.provide(AWS.ControlTower.GetLandingZoneOperationHttp)`.
### Polling Asynchronous Operations
**Example:** Poll a Landing Zone Operation
```typescript
// init — account-level binding takes no resource
const getLandingZoneOperation =
  yield* AWS.ControlTower.GetLandingZoneOperation();

// runtime
const { operationDetails } = yield* getLandingZoneOperation({
  operationIdentifier,
});
console.log(operationDetails.status);
```

@binding

## ListBaselines

Runtime binding for `controltower:ListBaselines`.

An account-level operation that enumerates the Control Tower baseline
catalog (e.g. `AWSControlTowerBaseline`, `AuditBaseline`,
`LogArchiveBaseline`). Useful for governance functions that discover the
baseline ARN to enable on an organizational unit. Provide the
implementation with `Effect.provide(AWS.ControlTower.ListBaselinesHttp)`.
### Browsing the Baseline Catalog
**Example:** List the Available Baselines
```typescript
// init — account-level binding takes no resource
const listBaselines = yield* AWS.ControlTower.ListBaselines();

// runtime
const result = yield* listBaselines();
const ouBaseline = result.baselines.find(
  (b) => b.name === "AWSControlTowerBaseline",
);
```

@binding

## ListControlOperations

Runtime binding for `controltower:ListControlOperations`.

An account-level operation that enumerates recent control operations
(enables, disables, updates, and resets), optionally filtered by status,
control, or target. Useful for governance dashboards that surface
in-flight or failed guardrail deployments. Provide the implementation
with `Effect.provide(AWS.ControlTower.ListControlOperationsHttp)`.
### Polling Asynchronous Operations
**Example:** List Failed Control Operations
```typescript
// init — account-level binding takes no resource
const listControlOperations = yield* AWS.ControlTower.ListControlOperations();

// runtime
const result = yield* listControlOperations({
  filter: { statuses: ["FAILED"] },
});
console.log(result.controlOperations.length);
```

@binding

## ListEnabledBaselines

Runtime binding for `controltower:ListEnabledBaselines`.

An account-level operation that enumerates the baselines enabled across
the organization's targets, optionally filtered by target or baseline
identifiers. Useful for compliance dashboards that report which OUs are
registered with Control Tower. Provide the implementation with
`Effect.provide(AWS.ControlTower.ListEnabledBaselinesHttp)`.
### Auditing Enablements
**Example:** List Baselines Enabled on an OU
```typescript
// init — account-level binding takes no resource
const listEnabledBaselines = yield* AWS.ControlTower.ListEnabledBaselines();

// runtime
const result = yield* listEnabledBaselines({
  filter: { targetIdentifiers: [ouArn] },
});
const statuses = result.enabledBaselines.map(
  (b) => b.statusSummary.status,
);
```

@binding

## ListEnabledControls

Runtime binding for `controltower:ListEnabledControls`.

An account-level operation that enumerates the controls (guardrails)
enabled on an organizational unit — or, with a filter, across the whole
organization. Useful for compliance dashboards and drift-detection
functions. Provide the implementation with
`Effect.provide(AWS.ControlTower.ListEnabledControlsHttp)`.
### Auditing Enablements
**Example:** List Controls Enabled on an OU
```typescript
// init — account-level binding takes no resource
const listEnabledControls = yield* AWS.ControlTower.ListEnabledControls();

// runtime
const result = yield* listEnabledControls({ targetIdentifier: ouArn });
const drifted = result.enabledControls.filter(
  (c) => c.driftStatusSummary?.driftStatus === "DRIFTED",
);
```

@binding

## ListLandingZoneOperations

Runtime binding for `controltower:ListLandingZoneOperations`.

An account-level operation that enumerates recent landing zone operations
(creates, updates, deletes, and resets), optionally filtered by type or
status. Useful for governance dashboards that surface in-flight landing
zone upgrades. Provide the implementation with
`Effect.provide(AWS.ControlTower.ListLandingZoneOperationsHttp)`.
### Polling Asynchronous Operations
**Example:** List In-Progress Landing Zone Operations
```typescript
// init — account-level binding takes no resource
const listLandingZoneOperations =
  yield* AWS.ControlTower.ListLandingZoneOperations();

// runtime
const result = yield* listLandingZoneOperations({
  filter: { statuses: ["IN_PROGRESS"] },
});
console.log(result.landingZoneOperations.length);
```

@binding

## ListLandingZones

Runtime binding for `controltower:ListLandingZones`.

An account-level operation that returns the organization's landing zone
ARN (a landing zone is a singleton — the list has at most one entry).
Useful for governance functions that discover the landing zone before
reading its drift status. Provide the implementation with
`Effect.provide(AWS.ControlTower.ListLandingZonesHttp)`.
### Inspecting the Landing Zone
**Example:** Discover the Landing Zone ARN
```typescript
// init — account-level binding takes no resource
const listLandingZones = yield* AWS.ControlTower.ListLandingZones();

// runtime
const result = yield* listLandingZones();
const arn = result.landingZones[0]?.arn;
```

@binding

## ResetEnabledBaseline

Runtime binding for `controltower:ResetEnabledBaseline`.

Bind this operation to an {@link EnabledBaseline} to re-enroll the
target with its baseline from inside a function runtime — remediating
drift without changing the enablement's configuration. The call starts an
asynchronous operation; poll it with {@link GetBaselineOperation}.
Provide the implementation with
`Effect.provide(AWS.ControlTower.ResetEnabledBaselineHttp)`.
### Remediating Drift
**Example:** Reset a Drifted Enabled Baseline
```typescript
// init — bind the operation to the enabled baseline
const resetEnabledBaseline = yield* AWS.ControlTower.ResetEnabledBaseline(ouBaseline);

// runtime
const { operationIdentifier } = yield* resetEnabledBaseline();
```

@binding

## ResetEnabledControl

Runtime binding for `controltower:ResetEnabledControl`.

Bind this operation to an {@link EnabledControl} to re-deploy the
guardrail's governance resources from inside a function runtime —
remediating drift without changing the enablement's configuration. The
call starts an asynchronous operation; poll it with
{@link GetControlOperation}. Provide the implementation with
`Effect.provide(AWS.ControlTower.ResetEnabledControlHttp)`.
### Remediating Drift
**Example:** Reset a Drifted Enabled Control
```typescript
// init — bind the operation to the enabled control
const resetEnabledControl = yield* AWS.ControlTower.ResetEnabledControl(guardrail);

// runtime
const { operationIdentifier } = yield* resetEnabledControl();
```

@binding

## ResetLandingZone

Runtime binding for `controltower:ResetLandingZone`.

Bind this operation to a {@link LandingZone} to re-deploy the landing
zone to its last-known configuration from inside a function runtime —
remediating landing zone drift. The call starts an asynchronous operation
(landing zone operations routinely take an hour); poll it with
{@link GetLandingZoneOperation}. Provide the implementation with
`Effect.provide(AWS.ControlTower.ResetLandingZoneHttp)`.
### Remediating Drift
**Example:** Reset a Drifted Landing Zone
```typescript
// init — bind the operation to the landing zone
const resetLandingZone = yield* AWS.ControlTower.ResetLandingZone(landingZone);

// runtime
const { operationIdentifier } = yield* resetLandingZone();
```

@binding
