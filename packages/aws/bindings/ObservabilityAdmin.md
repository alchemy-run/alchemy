<!-- Docs for the generated AWS.ObservabilityAdmin bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetTelemetryEnrichmentStatus

Runtime binding for `observabilityadmin:GetTelemetryEnrichmentStatus` —
reads the status of the account's telemetry enrichment feature (resource
tags added to telemetry). Fails with a typed
`ResourceNotFoundException` when the account has never onboarded to
enrichment.

Provide `AWS.ObservabilityAdmin.GetTelemetryEnrichmentStatusHttp` on the
hosting Lambda Function to satisfy the requirement.
### Reading Enrichment Status
**Example:** Read the enrichment status, tolerating never-onboarded
```typescript
// init — grants observabilityadmin:GetTelemetryEnrichmentStatus
const getEnrichmentStatus = yield* AWS.ObservabilityAdmin.GetTelemetryEnrichmentStatus();

// runtime
const status = yield* getEnrichmentStatus().pipe(
  Effect.map((r) => r.Status ?? "Stopped"),
  Effect.catchTag("ResourceNotFoundException", () =>
    Effect.succeed("NotOnboarded"),
  ),
);
```

@binding

## GetTelemetryEvaluationStatus

Runtime binding for `observabilityadmin:GetTelemetryEvaluationStatus` —
reads the account's telemetry config onboarding status (`RUNNING`,
`STOPPED`, `NOT_STARTED`, ...), e.g. for a compliance function that
verifies telemetry auditing stays enabled.

Provide `AWS.ObservabilityAdmin.GetTelemetryEvaluationStatusHttp` on the
hosting Lambda Function to satisfy the requirement.
### Reading Onboarding Status
**Example:** Verify telemetry auditing is enabled
```typescript
// init — grants observabilityadmin:GetTelemetryEvaluationStatus
const getEvaluationStatus = yield* AWS.ObservabilityAdmin.GetTelemetryEvaluationStatus();

// runtime
const { Status } = yield* getEvaluationStatus();
if (Status !== "RUNNING") {
  yield* Effect.logWarning("telemetry auditing is off");
}
```

@binding

## ListResourceTelemetry

Runtime binding for `observabilityadmin:ListResourceTelemetry` — audits
which AWS resources (VPCs, Lambda functions, ...) have telemetry such as
flow logs configured, and in what state. The account-level telemetry
config data plane; requires the account to be onboarded (see
`ObservabilityAdmin.TelemetryConfig`).

Provide `AWS.ObservabilityAdmin.ListResourceTelemetryHttp` on the hosting
Lambda Function to satisfy the requirement.

Known platform quirk (observed 2026-07): the service's authorization for
this action can reject callers whose grant comes from an inline role
policy (even `observabilityadmin:*` on `Resource: "*"`) with a typed
`AccessDeniedException`, while principals with managed policies succeed.
Handle the typed tag until AWS fixes the action's auth integration.
### Auditing Resource Telemetry
**Example:** Find VPCs without flow logs
```typescript
// init — grants observabilityadmin:ListResourceTelemetry
const listResourceTelemetry = yield* AWS.ObservabilityAdmin.ListResourceTelemetry();

// runtime
const { TelemetryConfigurations } = yield* listResourceTelemetry({
  ResourceTypes: ["AWS::EC2::VPC"],
  TelemetryConfigurationState: { Logs: "NotEnabled" },
});
```

@binding

## ListTelemetryRules

Runtime binding for `observabilityadmin:ListTelemetryRules` — enumerates
the account's telemetry rules (name, ARN, telemetry type, source types),
e.g. for an audit function that reports which auto-enable rules exist.

Provide `AWS.ObservabilityAdmin.ListTelemetryRulesHttp` on the hosting
Lambda Function to satisfy the requirement.
### Listing Telemetry Rules
**Example:** Enumerate the account's telemetry rules
```typescript
// init — grants observabilityadmin:ListTelemetryRules
const listTelemetryRules = yield* AWS.ObservabilityAdmin.ListTelemetryRules();

// runtime
const { TelemetryRuleSummaries } = yield* listTelemetryRules();
for (const rule of TelemetryRuleSummaries ?? []) {
  yield* Effect.log(`${rule.RuleName}: ${rule.TelemetryType}`);
}
```

@binding
