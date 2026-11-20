<!-- Docs for the generated AWS.Detective bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AcceptInvitation

Runtime binding for `detective:AcceptInvitation`.

Accepts an invitation into an administrator account's behavior graph —
the graph belongs to the admin account, so its ARN arrives at runtime
(typically from `ListInvitations`) rather than from a bound resource.
Provide the implementation with
`Effect.provide(AWS.Detective.AcceptInvitationHttp)`.
### Responding to Invitations
**Example:** Auto-Accept An Invitation
```typescript
// init — account-level binding, no resource argument
const acceptInvitation = yield* AWS.Detective.AcceptInvitation();

// runtime
yield* acceptInvitation({ GraphArn: invitation.GraphArn! });
```

@binding

## BatchGetGraphMemberDatasources

Runtime binding for `detective:BatchGetGraphMemberDatasources`.

Reads per-member data source ingest history for the behavior graph —
which packages each member account is contributing and when their ingest
state last changed. The graph ARN is injected from the bound {@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.BatchGetGraphMemberDatasourcesHttp)`.
### Managing Data Source Packages
**Example:** Inspect Member Ingest History
```typescript
// init
const batchGetGraphMemberDatasources =
  yield* AWS.Detective.BatchGetGraphMemberDatasources(graph);

// runtime
const { MemberDatasources } = yield* batchGetGraphMemberDatasources({
  AccountIds: ["111122223333"],
});
```

@binding

## BatchGetMembershipDatasources

Runtime binding for `detective:BatchGetMembershipDatasources`.

Reads this account's data source ingest history across the behavior
graphs it is a member of — the member-side view of what each admin's
graph is ingesting from this account.
Provide the implementation with
`Effect.provide(AWS.Detective.BatchGetMembershipDatasourcesHttp)`.
### Responding to Invitations
**Example:** Inspect Membership Data Sources
```typescript
// init — account-level binding, no resource argument
const batchGetMembershipDatasources =
  yield* AWS.Detective.BatchGetMembershipDatasources();

// runtime
const { MembershipDatasources } = yield* batchGetMembershipDatasources({
  GraphArns: [adminGraphArn],
});
```

@binding

## CreateMembers

Runtime binding for `detective:CreateMembers`.

Invites accounts into the behavior graph (or auto-enables organization
accounts) — the automation hook for onboarding new accounts to Detective
as they join the fleet. The graph ARN is injected from the bound
{@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.CreateMembersHttp)`.
### Administering Member Accounts
**Example:** Invite A New Member Account
```typescript
// init
const createMembers = yield* AWS.Detective.CreateMembers(graph);

// runtime
yield* createMembers({
  Accounts: [{ AccountId: "111122223333", EmailAddress: email }],
  DisableEmailNotification: true,
});
```

@binding

## DeleteMembers

Runtime binding for `detective:DeleteMembers`.

Removes member accounts from the behavior graph — the off-boarding
counterpart to `CreateMembers` when an account leaves the fleet. The graph
ARN is injected from the bound {@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.DeleteMembersHttp)`.
### Administering Member Accounts
**Example:** Remove A Member Account
```typescript
// init
const deleteMembers = yield* AWS.Detective.DeleteMembers(graph);

// runtime
yield* deleteMembers({ AccountIds: ["111122223333"] });
```

@binding

## DescribeOrganizationConfiguration

Runtime binding for `detective:DescribeOrganizationConfiguration`.

Reads whether new organization accounts are auto-enabled as members of
the behavior graph. Callable only by the organization's delegated
Detective administrator account. The graph ARN is injected from the bound
{@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.DescribeOrganizationConfigurationHttp)`.
### Organization Administration
**Example:** Check Auto-Enable
```typescript
// init
const describeOrganizationConfiguration =
  yield* AWS.Detective.DescribeOrganizationConfiguration(graph);

// runtime
const { AutoEnable } = yield* describeOrganizationConfiguration();
```

@binding

## DisableOrganizationAdminAccount

Runtime binding for `detective:DisableOrganizationAdminAccount`.

Revokes the organization's delegated Detective administrator. Callable
only from the organization management account.
Provide the implementation with
`Effect.provide(AWS.Detective.DisableOrganizationAdminAccountHttp)`.
### Organization Administration
**Example:** Revoke The Delegated Administrator
```typescript
// init — account-level binding, no resource argument
const disableOrganizationAdminAccount =
  yield* AWS.Detective.DisableOrganizationAdminAccount();

// runtime
yield* disableOrganizationAdminAccount();
```

@binding

## DisassociateMembership

Runtime binding for `detective:DisassociateMembership`.

Removes *this* account from a behavior graph it previously accepted an
invitation to — the member-side exit, mirroring the admin's
`DeleteMembers`.
Provide the implementation with
`Effect.provide(AWS.Detective.DisassociateMembershipHttp)`.
### Responding to Invitations
**Example:** Leave A Behavior Graph
```typescript
// init — account-level binding, no resource argument
const disassociateMembership = yield* AWS.Detective.DisassociateMembership();

// runtime
yield* disassociateMembership({ GraphArn: adminGraphArn });
```

@binding

## EnableOrganizationAdminAccount

Runtime binding for `detective:EnableOrganizationAdminAccount`.

Designates an organization account as the delegated Detective
administrator. Callable only from the organization management account —
the org-governance automation hook.
Provide the implementation with
`Effect.provide(AWS.Detective.EnableOrganizationAdminAccountHttp)`.
### Organization Administration
**Example:** Delegate The Security Account
```typescript
// init — account-level binding, no resource argument
const enableOrganizationAdminAccount =
  yield* AWS.Detective.EnableOrganizationAdminAccount();

// runtime
yield* enableOrganizationAdminAccount({ AccountId: securityAccountId });
```

@binding

## GetInvestigation

Runtime binding for `detective:GetInvestigation`.

Reads a single investigation's detail — entity, scope window, status,
severity, and state — so a triage function can poll a running
investigation to completion. The graph ARN is injected from the bound
{@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.GetInvestigationHttp)`.
### Running Investigations
**Example:** Poll An Investigation
```typescript
// init
const getInvestigation = yield* AWS.Detective.GetInvestigation(graph);

// runtime
const detail = yield* getInvestigation({ InvestigationId: id });
if (detail.Status === "SUCCESSFUL") {
  yield* Effect.log(`severity: ${detail.Severity}`);
}
```

@binding

## GetMembers

Runtime binding for `detective:GetMembers`.

Reads the membership details of specific accounts in the behavior graph —
status, volume usage, and per-package ingest states. Unknown accounts come
back in `UnprocessedAccounts`. The graph ARN is injected from the bound
{@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.GetMembersHttp)`.
### Administering Member Accounts
**Example:** Check A Member's Status
```typescript
// init
const getMembers = yield* AWS.Detective.GetMembers(graph);

// runtime
const { MemberDetails } = yield* getMembers({
  AccountIds: ["111122223333"],
});
```

@binding

## ListDatasourcePackages

Runtime binding for `detective:ListDatasourcePackages`.

Lists the behavior graph's data source packages (core CloudTrail/VPC Flow,
EKS audit, ASFF findings) and their ingest state — audit what Detective is
actually ingesting. The graph ARN is injected from the bound {@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.ListDatasourcePackagesHttp)`.
### Managing Data Source Packages
**Example:** Audit Ingested Data Sources
```typescript
// init
const listDatasourcePackages =
  yield* AWS.Detective.ListDatasourcePackages(graph);

// runtime
const { DatasourcePackages } = yield* listDatasourcePackages();
```

@binding

## ListIndicators

Runtime binding for `detective:ListIndicators`.

Lists the indicators of compromise a finished investigation surfaced —
TTPs, impossible travel, new geolocations, related findings — the raw
material for an automated triage report. The graph ARN is injected from
the bound {@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.ListIndicatorsHttp)`.
### Running Investigations
**Example:** Read An Investigation's Indicators
```typescript
// init
const listIndicators = yield* AWS.Detective.ListIndicators(graph);

// runtime
const { Indicators } = yield* listIndicators({ InvestigationId: id });
```

@binding

## ListInvestigations

Runtime binding for `detective:ListInvestigations`.

Enumerates the behavior graph's investigations with optional filter and
sort criteria — list everything triaged in the last week, or every
investigation still `ACTIVE`. The graph ARN is injected from the bound
{@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.ListInvestigationsHttp)`.
### Running Investigations
**Example:** List Active Investigations
```typescript
// init
const listInvestigations = yield* AWS.Detective.ListInvestigations(graph);

// runtime
const { InvestigationDetails } = yield* listInvestigations();
```

@binding

## ListInvitations

Runtime binding for `detective:ListInvitations`.

Lists open behavior-graph invitations *received by this account* — the
member-account side of the Detective handshake, ready for an automation
that auto-accepts invitations from the security account.
Provide the implementation with
`Effect.provide(AWS.Detective.ListInvitationsHttp)`.
### Responding to Invitations
**Example:** List Pending Invitations
```typescript
// init — account-level binding, no resource argument
const listInvitations = yield* AWS.Detective.ListInvitations();

// runtime
const { Invitations } = yield* listInvitations();
```

@binding

## ListMembers

Runtime binding for `detective:ListMembers`.

Lists the behavior graph's member accounts — invited and enabled alike —
so an admin-account function can audit coverage of the security fleet.
The graph ARN is injected from the bound {@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.ListMembersHttp)`.
### Administering Member Accounts
**Example:** List Member Accounts
```typescript
// init
const listMembers = yield* AWS.Detective.ListMembers(graph);

// runtime
const { MemberDetails } = yield* listMembers();
```

@binding

## ListOrganizationAdminAccounts

Runtime binding for `detective:ListOrganizationAdminAccounts`.

Lists the organization's delegated Detective administrator account.
Callable only from the organization management account.
Provide the implementation with
`Effect.provide(AWS.Detective.ListOrganizationAdminAccountsHttp)`.
### Organization Administration
**Example:** Find The Delegated Administrator
```typescript
// init — account-level binding, no resource argument
const listOrganizationAdminAccounts =
  yield* AWS.Detective.ListOrganizationAdminAccounts();

// runtime
const { Administrators } = yield* listOrganizationAdminAccounts();
```

@binding

## RejectInvitation

Runtime binding for `detective:RejectInvitation`.

Rejects an open invitation into an administrator account's behavior
graph — the decline path of the member-account invitation flow.
Provide the implementation with
`Effect.provide(AWS.Detective.RejectInvitationHttp)`.
### Responding to Invitations
**Example:** Decline An Invitation
```typescript
// init — account-level binding, no resource argument
const rejectInvitation = yield* AWS.Detective.RejectInvitation();

// runtime
yield* rejectInvitation({ GraphArn: invitation.GraphArn! });
```

@binding

## StartInvestigation

Runtime binding for `detective:StartInvestigation`.

Kicks off a Detective investigation into an IAM user or role over a time
window — the programmatic version of the console's "Run investigation"
button. A security-automation function can trigger triage the moment a
GuardDuty finding lands. The graph ARN is injected from the bound
{@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.StartInvestigationHttp)`.
### Running Investigations
**Example:** Investigate A Suspicious Role
```typescript
// init — bind the operation to the behavior graph
const startInvestigation = yield* AWS.Detective.StartInvestigation(graph);

// runtime
const { InvestigationId } = yield* startInvestigation({
  EntityArn: suspiciousRoleArn,
  ScopeStartTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
  ScopeEndTime: new Date(),
});
```

@binding

## StartMonitoringMember

Runtime binding for `detective:StartMonitoringMember`.

Re-enables data ingest for a member account that was accepted but is
`ACCEPTED_BUT_DISABLED` (e.g. it previously blew the graph's volume
limit). The graph ARN is injected from the bound {@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.StartMonitoringMemberHttp)`.
### Administering Member Accounts
**Example:** Resume Ingest For A Member
```typescript
// init
const startMonitoringMember =
  yield* AWS.Detective.StartMonitoringMember(graph);

// runtime
yield* startMonitoringMember({ AccountId: "111122223333" });
```

@binding

## UpdateDatasourcePackages

Runtime binding for `detective:UpdateDatasourcePackages`.

Starts ingest for additional data source packages (e.g. `EKS_AUDIT`,
`ASFF_SECURITYHUB_FINDING`) on the behavior graph. Enabling a package is
irreversible through this API and affects Detective billing. The graph ARN
is injected from the bound {@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.UpdateDatasourcePackagesHttp)`.
### Managing Data Source Packages
**Example:** Enable EKS Audit Ingest
```typescript
// init
const updateDatasourcePackages =
  yield* AWS.Detective.UpdateDatasourcePackages(graph);

// runtime
yield* updateDatasourcePackages({ DatasourcePackages: ["EKS_AUDIT"] });
```

@binding

## UpdateInvestigationState

Runtime binding for `detective:UpdateInvestigationState`.

Moves an investigation between `ACTIVE` and `ARCHIVED` — close out a
triaged investigation from the same function that opened it. The graph
ARN is injected from the bound {@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.UpdateInvestigationStateHttp)`.
### Running Investigations
**Example:** Archive A Triaged Investigation
```typescript
// init
const updateInvestigationState =
  yield* AWS.Detective.UpdateInvestigationState(graph);

// runtime
yield* updateInvestigationState({ InvestigationId: id, State: "ARCHIVED" });
```

@binding

## UpdateOrganizationConfiguration

Runtime binding for `detective:UpdateOrganizationConfiguration`.

Toggles auto-enable for new organization accounts on the behavior graph.
Callable only by the organization's delegated Detective administrator
account. The graph ARN is injected from the bound {@link Graph}.
Provide the implementation with
`Effect.provide(AWS.Detective.UpdateOrganizationConfigurationHttp)`.
### Organization Administration
**Example:** Auto-Enable New Organization Accounts
```typescript
// init
const updateOrganizationConfiguration =
  yield* AWS.Detective.UpdateOrganizationConfiguration(graph);

// runtime
yield* updateOrganizationConfiguration({ AutoEnable: true });
```

@binding
