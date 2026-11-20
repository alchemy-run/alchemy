<!-- Docs for the generated AWS.AIOps bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetInvestigationGroup

Runtime binding for `aiops:GetInvestigationGroup`.

Reads the bound {@link InvestigationGroup}'s full configuration — the
telemetry-access role, retention period, encryption, tag key boundaries,
chatbot notification channels, and cross-account configurations — so an
ops function can audit or report on the Region's investigation setup. The
group's ARN is injected from the binding. Provide the implementation with
`Effect.provide(AWS.AIOps.GetInvestigationGroupHttp)`.
### Reading the Investigation Group
**Example:** Inspect the Group's Configuration
```typescript
// init — grants aiops:GetInvestigationGroup on the group
const getInvestigationGroup = yield* AWS.AIOps.GetInvestigationGroup(group);

// runtime
const detail = yield* getInvestigationGroup();
yield* Effect.log(
  `${detail.name} retains investigations for ${detail.retentionInDays} days`,
);
```

@binding

## GetInvestigationGroupPolicy

Runtime binding for `aiops:GetInvestigationGroupPolicy`.

Reads the IAM resource policy attached to the bound
{@link InvestigationGroup} (the policy that lets principals like
`aiops.alarms.cloudwatch.amazonaws.com` create investigations), returned
as a JSON string. Fails with the typed `ResourceNotFoundException` when no
policy is attached. The group's ARN is injected from the binding. Provide
the implementation with
`Effect.provide(AWS.AIOps.GetInvestigationGroupPolicyHttp)`.
### Reading the Resource Policy
**Example:** Audit Who Can Start Investigations
```typescript
// init — grants aiops:GetInvestigationGroupPolicy on the group
const getInvestigationGroupPolicy =
  yield* AWS.AIOps.GetInvestigationGroupPolicy(group);

// runtime — no policy attached surfaces as a typed error
const attached = yield* getInvestigationGroupPolicy().pipe(
  Effect.map((r) => r.policy),
  Effect.catchTag("ResourceNotFoundException", () =>
    Effect.succeed(undefined),
  ),
);
```

@binding

## ListInvestigationGroups

Runtime binding for `aiops:ListInvestigationGroups`.

Enumerates the Region's investigation groups (each item carries the
group's name and ARN). An account holds at most one investigation group
per Region, so this doubles as an existence probe. Provide the
implementation with
`Effect.provide(AWS.AIOps.ListInvestigationGroupsHttp)`.
### Listing Investigation Groups
**Example:** Discover the Region's Investigation Group
```typescript
// init — account-level binding, no resource argument
const listInvestigationGroups = yield* AWS.AIOps.ListInvestigationGroups();

// runtime
const { investigationGroups } = yield* listInvestigationGroups();
for (const group of investigationGroups ?? []) {
  yield* Effect.log(`${group.name}: ${group.arn}`);
}
```

@binding

## ListTagsForResource

Runtime binding for `aiops:ListTagsForResource`.

Reads the tags on the bound {@link InvestigationGroup} — useful for
ownership/audit reporting from an ops function. The group's ARN is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.AIOps.ListTagsForResourceHttp)`.
### Reading Tags
**Example:** List the Group's Tags
```typescript
// init — grants aiops:ListTagsForResource on the group
const listTagsForResource = yield* AWS.AIOps.ListTagsForResource(group);

// runtime
const { tags } = yield* listTagsForResource();
yield* Effect.log(`owned by team ${tags?.Team}`);
```

@binding
