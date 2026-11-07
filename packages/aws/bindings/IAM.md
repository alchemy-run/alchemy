<!-- Docs for the generated AWS.IAM bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GenerateCredentialReport

Runtime binding for `iam:GenerateCredentialReport` — kick off generation of
the account-wide credential report (per-user password/key/MFA hygiene as
CSV). Pair with {@link GetCredentialReport} to retrieve the report once the
returned `State` is `COMPLETE`.

Account-singleton operation: the binding takes no arguments and grants
`iam:GenerateCredentialReport` on `*`. Provide the implementation with
`Effect.provide(AWS.IAM.GenerateCredentialReportHttp)`.

### Credential Reports
**Example:** Start a Credential Report
```typescript
// init
const generateCredentialReport = yield* IAM.GenerateCredentialReport();

// runtime
const { State } = yield* generateCredentialReport();
// "STARTED" | "INPROGRESS" | "COMPLETE"
```

@binding

## GenerateServiceLastAccessedDetails

Runtime binding for `iam:GenerateServiceLastAccessedDetails` — start an
access-advisor report for an IAM user, group, role, or policy, answering
"which services has this entity actually used?". Pair with
{@link GetServiceLastAccessedDetails} to poll the returned `JobId`.

The target entity (`Arn`) is chosen per request — least-privilege tooling
typically iterates entities discovered at runtime — so the binding takes no
arguments and grants `iam:GenerateServiceLastAccessedDetails` on `*`.
Provide the implementation with
`Effect.provide(AWS.IAM.GenerateServiceLastAccessedDetailsHttp)`.

### Access Advisor
**Example:** Start an Access Report for a Role
```typescript
// init
const generateServiceLastAccessedDetails =
  yield* IAM.GenerateServiceLastAccessedDetails();

// runtime
const { JobId } = yield* generateServiceLastAccessedDetails({
  Arn: roleArn,
});
```

@binding

## GetAccountAuthorizationDetails

Runtime binding for `iam:GetAccountAuthorizationDetails` — snapshot every
IAM user, group, role, and policy in the account together with their
relationships. The single-call foundation for permission-graph analyzers
and drift detectors.

Account-singleton operation: the binding takes no arguments and grants
`iam:GetAccountAuthorizationDetails` on `*`. Provide the implementation
with `Effect.provide(AWS.IAM.GetAccountAuthorizationDetailsHttp)`.

### Account Auditing
**Example:** Snapshot Roles and Their Policies
```typescript
// init
const getAuthorizationDetails = yield* IAM.GetAccountAuthorizationDetails();

// runtime — paginate with the Marker until IsTruncated is false
const page = yield* getAuthorizationDetails({
  Filter: ["Role"],
  MaxItems: 100,
});
const roles = page.RoleDetailList ?? [];
```

@binding

## GetAccountSummary

Runtime binding for `iam:GetAccountSummary` — read IAM entity usage and
quota counters for the account (`Users`, `Roles`, `PoliciesQuota`, `MFADevices`,
`AccountMFAEnabled`, …). The quick health snapshot behind quota alarms and
security dashboards.

Account-singleton operation: the binding takes no arguments and grants
`iam:GetAccountSummary` on `*`. Provide the implementation with
`Effect.provide(AWS.IAM.GetAccountSummaryHttp)`.

### Account Auditing
**Example:** Alarm When Nearing the Role Quota
```typescript
// init
const getAccountSummary = yield* IAM.GetAccountSummary();

// runtime
const { SummaryMap } = yield* getAccountSummary();
const nearQuota =
  (SummaryMap?.Roles ?? 0) > 0.9 * (SummaryMap?.RolesQuota ?? Infinity);
```

@binding

## GetContextKeysForCustomPolicy

Runtime binding for `iam:GetContextKeysForCustomPolicy` — list the condition
context keys (`aws:username`, `aws:SourceIp`, …) referenced by a set of
candidate policy documents, so a simulation can be primed with the right
`ContextEntries`.

The policies are supplied as strings per request, so the binding takes no
arguments and grants `iam:GetContextKeysForCustomPolicy` on `*`. Provide the
implementation with `Effect.provide(AWS.IAM.GetContextKeysForCustomPolicyHttp)`.

### Simulating Policies
**Example:** Discover a Policy's Context Keys
```typescript
// init
const getContextKeys = yield* IAM.GetContextKeysForCustomPolicy();

// runtime
const { ContextKeyNames } = yield* getContextKeys({
  PolicyInputList: [policyJson],
});
```

@binding

## GetContextKeysForPrincipalPolicy

Runtime binding for `iam:GetContextKeysForPrincipalPolicy` — list the
condition context keys referenced by all policies attached to an existing
IAM user, group, or role, so a principal simulation can be primed with the
right `ContextEntries`.

The principal (`PolicySourceArn`) is chosen per request, so the binding
takes no arguments and grants `iam:GetContextKeysForPrincipalPolicy` on
`*`. Provide the implementation with
`Effect.provide(AWS.IAM.GetContextKeysForPrincipalPolicyHttp)`.

### Simulating Policies
**Example:** Discover a Role's Context Keys
```typescript
// init
const getContextKeys = yield* IAM.GetContextKeysForPrincipalPolicy();

// runtime
const { ContextKeyNames } = yield* getContextKeys({
  PolicySourceArn: roleArn,
});
```

@binding

## GetCredentialReport

Runtime binding for `iam:GetCredentialReport` — download the account-wide
credential report started by {@link GenerateCredentialReport}. The report is
base64-encoded CSV of per-user credential hygiene (password age, key
rotation, MFA status); it contains no secret material.

Retrieval before a report exists surfaces the typed
`CredentialReportNotPresentException` / `CredentialReportNotReadyException`
tags. Account-singleton operation: the binding takes no arguments and
grants `iam:GetCredentialReport` on `*`. Provide the implementation with
`Effect.provide(AWS.IAM.GetCredentialReportHttp)`.

### Credential Reports
**Example:** Retrieve the Credential Report
```typescript
// init
const getCredentialReport = yield* IAM.GetCredentialReport();

// runtime
const report = yield* getCredentialReport().pipe(
  Effect.map((r) => new TextDecoder().decode(r.Content)),
  Effect.catchTag("CredentialReportNotPresentException", () =>
    Effect.succeed(undefined),
  ),
);
```

@binding

## GetServiceLastAccessedDetails

Runtime binding for `iam:GetServiceLastAccessedDetails` — poll and read the
access-advisor report started by {@link GenerateServiceLastAccessedDetails}:
job status plus, when `COMPLETED`, the per-service last-authenticated
timeline for the entity.

The `JobId` is produced at runtime, so the binding takes no arguments and
grants `iam:GetServiceLastAccessedDetails` on `*`. Provide the
implementation with
`Effect.provide(AWS.IAM.GetServiceLastAccessedDetailsHttp)`.

### Access Advisor
**Example:** Read a Completed Access Report
```typescript
// init
const getServiceLastAccessedDetails =
  yield* IAM.GetServiceLastAccessedDetails();

// runtime
const report = yield* getServiceLastAccessedDetails({ JobId: jobId });
if (report.JobStatus === "COMPLETED") {
  const unused = report.ServicesLastAccessed?.filter(
    (s) => s.LastAuthenticated === undefined,
  );
}
```

@binding

## GetServiceLastAccessedDetailsWithEntities

Runtime binding for `iam:GetServiceLastAccessedDetailsWithEntities` — after
an access-advisor job generated for a *group or policy*, drill into which
member users/roles actually attempted to use a given service namespace.

The `JobId` is produced at runtime, so the binding takes no arguments and
grants `iam:GetServiceLastAccessedDetailsWithEntities` on `*`. Provide the
implementation with
`Effect.provide(AWS.IAM.GetServiceLastAccessedDetailsWithEntitiesHttp)`.

### Access Advisor
**Example:** List the Entities That Used a Service
```typescript
// init
const getDetailsWithEntities =
  yield* IAM.GetServiceLastAccessedDetailsWithEntities();

// runtime
const { EntityDetailsList } = yield* getDetailsWithEntities({
  JobId: jobId,
  ServiceNamespace: "s3",
});
```

@binding

## ListPoliciesGrantingServiceAccess

Runtime binding for `iam:ListPoliciesGrantingServiceAccess` — list which
attached/inline policies grant an IAM user, group, or role access to given
service namespaces. The companion to access advisor for answering "*why*
can this entity reach that service?".

The entity (`Arn`) is chosen per request, so the binding takes no arguments
and grants `iam:ListPoliciesGrantingServiceAccess` on `*`. Provide the
implementation with
`Effect.provide(AWS.IAM.ListPoliciesGrantingServiceAccessHttp)`.

### Access Advisor
**Example:** Explain a Role's S3 Access
```typescript
// init
const listPoliciesGrantingServiceAccess =
  yield* IAM.ListPoliciesGrantingServiceAccess();

// runtime
const { PoliciesGrantingServiceAccess } =
  yield* listPoliciesGrantingServiceAccess({
    Arn: roleArn,
    ServiceNamespaces: ["s3"],
  });
```

@binding

## SimulateCustomPolicy

Runtime binding for `iam:SimulateCustomPolicy` — evaluate how a set of
candidate IAM policy documents would decide a list of actions, without
attaching the policies to any entity. The building block for policy
linters, "what would this grant?" previews, and authorization test
harnesses.

The policies are supplied as strings per request, so the binding takes no
arguments and grants `iam:SimulateCustomPolicy` on `*`. Provide the
implementation with `Effect.provide(AWS.IAM.SimulateCustomPolicyHttp)`.

### Simulating Policies
**Example:** Preview a Candidate Policy
```typescript
// init
const simulateCustomPolicy = yield* IAM.SimulateCustomPolicy();

// runtime
const { EvaluationResults } = yield* simulateCustomPolicy({
  PolicyInputList: [
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: "s3:ListAllMyBuckets", Resource: "*" },
      ],
    }),
  ],
  ActionNames: ["s3:ListAllMyBuckets", "s3:DeleteBucket"],
});
const decisions = EvaluationResults?.map((r) => r.EvalDecision);
```

@binding

## SimulatePrincipalPolicy

Runtime binding for `iam:SimulatePrincipalPolicy` — evaluate how the
policies attached to an existing IAM user, group, or role decide a list of
actions. The "can principal X do Y?" primitive behind access-review
dashboards and pre-flight permission checks.

The principal (`PolicySourceArn`) is chosen per request — audit tooling
typically iterates entities discovered at runtime — so the binding takes no
arguments and grants `iam:SimulatePrincipalPolicy` on `*`. Provide the
implementation with `Effect.provide(AWS.IAM.SimulatePrincipalPolicyHttp)`.

### Simulating Policies
**Example:** Check What a Role May Do
```typescript
// init
const simulatePrincipalPolicy = yield* IAM.SimulatePrincipalPolicy();

// runtime
const { EvaluationResults } = yield* simulatePrincipalPolicy({
  PolicySourceArn: roleArn,
  ActionNames: ["s3:GetObject", "iam:DeleteRole"],
});
const denied = EvaluationResults?.filter(
  (r) => r.EvalDecision !== "allowed",
);
```

@binding
