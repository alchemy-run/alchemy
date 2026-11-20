<!-- Docs for the generated AWS.GuardDuty bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AcceptAdministratorInvitation

Runtime binding for `guardduty:AcceptAdministratorInvitation`.

Accepts a GuardDuty administrator invitation — the member-account side of the invitation handshake.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.AcceptAdministratorInvitationHttp)`.
### Administrator & Invitations
**Example:** Accept an Invitation
```typescript
// init
const acceptAdministratorInvitation = yield* AWS.GuardDuty.AcceptAdministratorInvitation(detector);

// runtime
yield* acceptAdministratorInvitation({
  AdministratorId: adminAccountId,
  InvitationId: invitationId,
});
```

@binding

## ArchiveFindings

Runtime binding for `guardduty:ArchiveFindings`.

Archives triaged findings so they stop surfacing in the active queue. Only the administrator account owning the detector can archive.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.ArchiveFindingsHttp)`.
### Working with Findings
**Example:** Archive Triaged Findings
```typescript
// init
const archiveFindings = yield* AWS.GuardDuty.ArchiveFindings(detector);

// runtime
yield* archiveFindings({ FindingIds: findingIds });
```

@binding

## CreateInvestigation

Runtime binding for `guardduty:CreateInvestigation`.

Starts a GuardDuty Extended Threat Detection investigation from a natural-language trigger prompt.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.CreateInvestigationHttp)`.
### Extended Threat Detection
**Example:** Start an Investigation
```typescript
// init
const createInvestigation = yield* AWS.GuardDuty.CreateInvestigation(detector);

// runtime
const { InvestigationId } = yield* createInvestigation({
  TriggerPrompt: "Investigate the port probe findings on my web tier",
});
```

@binding

## CreateMembers

Runtime binding for `guardduty:CreateMembers`.

Associates member accounts with this administrator detector (organization-managed or invitation flow).
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.CreateMembersHttp)`.
### Member Administration
**Example:** Add a Member Account
```typescript
// init
const createMembers = yield* AWS.GuardDuty.CreateMembers(detector);

// runtime
yield* createMembers({
  AccountDetails: [{ AccountId: "111122223333", Email: "security@example.com" }],
});
```

@binding

## CreateSampleFindings

Runtime binding for `guardduty:CreateSampleFindings`.

Generates sample findings of the requested types — the standard way to exercise a finding-consumer pipeline end-to-end without staging a real threat.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.CreateSampleFindingsHttp)`.
### Working with Findings
**Example:** Generate a Sample Finding
```typescript
// init
const createSampleFindings = yield* AWS.GuardDuty.CreateSampleFindings(detector);

// runtime
yield* createSampleFindings({
  FindingTypes: ["Recon:EC2/PortProbeUnprotectedPort"],
});
```

@binding

## DeclineInvitations

Runtime binding for `guardduty:DeclineInvitations`.

Declines membership invitations from the given administrator account ids.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.DeclineInvitationsHttp)`.
### Administrator & Invitations
**Example:** Decline Invitations
```typescript
// init
// init — account-level binding, no resource argument
const declineInvitations = yield* AWS.GuardDuty.DeclineInvitations();

// runtime
yield* declineInvitations({ AccountIds: ["111122223333"] });
```

@binding

## DeleteInvitations

Runtime binding for `guardduty:DeleteInvitations`.

Deletes received membership invitations from the given administrator account ids.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.DeleteInvitationsHttp)`.
### Administrator & Invitations
**Example:** Delete Invitations
```typescript
// init
// init — account-level binding, no resource argument
const deleteInvitations = yield* AWS.GuardDuty.DeleteInvitations();

// runtime
yield* deleteInvitations({ AccountIds: ["111122223333"] });
```

@binding

## DeleteMembers

Runtime binding for `guardduty:DeleteMembers`.

Deletes member accounts from this administrator detector entirely.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.DeleteMembersHttp)`.
### Member Administration
**Example:** Delete Members
```typescript
// init
const deleteMembers = yield* AWS.GuardDuty.DeleteMembers(detector);

// runtime
yield* deleteMembers({ AccountIds: ["111122223333"] });
```

@binding

## DescribeMalwareScans

Runtime binding for `guardduty:DescribeMalwareScans`.

Lists EC2 malware scan results for the detector with optional filter and sort criteria.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.DescribeMalwareScansHttp)`.
### Malware Protection
**Example:** List Malware Scan Results
```typescript
// init
const describeMalwareScans = yield* AWS.GuardDuty.DescribeMalwareScans(detector);

// runtime
const { Scans } = yield* describeMalwareScans();
```

@binding

## DescribeOrganizationConfiguration

Runtime binding for `guardduty:DescribeOrganizationConfiguration`.

Reads the organization's GuardDuty auto-enable configuration (delegated administrator only).
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.DescribeOrganizationConfigurationHttp)`.
### Organization Administration
**Example:** Read Org Configuration
```typescript
// init
const describeOrganizationConfiguration = yield* AWS.GuardDuty.DescribeOrganizationConfiguration(detector);

// runtime
const { AutoEnableOrganizationMembers } =
  yield* describeOrganizationConfiguration();
```

@binding

## DisableOrganizationAdminAccount

Runtime binding for `guardduty:DisableOrganizationAdminAccount`.

Removes an account's delegation as the organization's GuardDuty administrator (management account only).
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.DisableOrganizationAdminAccountHttp)`.
### Organization Administration
**Example:** Remove a Delegated Administrator
```typescript
// init
// init — account-level binding, no resource argument
const disableOrganizationAdminAccount = yield* AWS.GuardDuty.DisableOrganizationAdminAccount();

// runtime
yield* disableOrganizationAdminAccount({ AdminAccountId: "111122223333" });
```

@binding

## DisassociateFromAdministratorAccount

Runtime binding for `guardduty:DisassociateFromAdministratorAccount`.

Disassociates this member detector from its administrator account.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.DisassociateFromAdministratorAccountHttp)`.
### Administrator & Invitations
**Example:** Leave the Administrator
```typescript
// init
const disassociateFromAdministratorAccount = yield* AWS.GuardDuty.DisassociateFromAdministratorAccount(detector);

// runtime
yield* disassociateFromAdministratorAccount();
```

@binding

## DisassociateMembers

Runtime binding for `guardduty:DisassociateMembers`.

Disassociates member accounts from this administrator detector without deleting them.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.DisassociateMembersHttp)`.
### Member Administration
**Example:** Disassociate Members
```typescript
// init
const disassociateMembers = yield* AWS.GuardDuty.DisassociateMembers(detector);

// runtime
yield* disassociateMembers({ AccountIds: ["111122223333"] });
```

@binding

## EnableOrganizationAdminAccount

Runtime binding for `guardduty:EnableOrganizationAdminAccount`.

Delegates an account as the organization's GuardDuty administrator (management account only).
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.EnableOrganizationAdminAccountHttp)`.
### Organization Administration
**Example:** Delegate an Administrator
```typescript
// init
// init — account-level binding, no resource argument
const enableOrganizationAdminAccount = yield* AWS.GuardDuty.EnableOrganizationAdminAccount();

// runtime
yield* enableOrganizationAdminAccount({ AdminAccountId: "111122223333" });
```

@binding

## GetAdministratorAccount

Runtime binding for `guardduty:GetAdministratorAccount`.

Reads the administrator account managing this detector (empty relationship for a standalone account).
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetAdministratorAccountHttp)`.
### Administrator & Invitations
**Example:** Read the Administrator
```typescript
// init
const getAdministratorAccount = yield* AWS.GuardDuty.GetAdministratorAccount(detector);

// runtime
const { Administrator } = yield* getAdministratorAccount();
```

@binding

## GetCoverageStatistics

Runtime binding for `guardduty:GetCoverageStatistics`.

Aggregates runtime-monitoring coverage counts (healthy vs unhealthy) for the detector's monitored resources.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetCoverageStatisticsHttp)`.
### Usage & Coverage
**Example:** Coverage by Resource Type
```typescript
// init
const getCoverageStatistics = yield* AWS.GuardDuty.GetCoverageStatistics(detector);

// runtime
const { CoverageStatistics } = yield* getCoverageStatistics({
  StatisticsType: ["COUNT_BY_RESOURCE_TYPE"],
});
```

@binding

## GetFindings

Runtime binding for `guardduty:GetFindings`.

Hydrates full finding details for a batch of finding ids returned by `ListFindings`.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetFindingsHttp)`.
### Working with Findings
**Example:** Hydrate Finding Details
```typescript
// init
const getFindings = yield* AWS.GuardDuty.GetFindings(detector);

// runtime
const { Findings } = yield* getFindings({ FindingIds: findingIds });
```

@binding

## GetFindingsStatistics

Runtime binding for `guardduty:GetFindingsStatistics`.

Aggregates the detector's findings into statistics (grouped by severity, account, resource, or finding type) for dashboards and alert thresholds.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetFindingsStatisticsHttp)`.
### Working with Findings
**Example:** Count Findings by Severity
```typescript
// init
const getFindingsStatistics = yield* AWS.GuardDuty.GetFindingsStatistics(detector);

// runtime
const { FindingStatistics } = yield* getFindingsStatistics({
  GroupBy: "SEVERITY",
});
```

@binding

## GetInvestigation

Runtime binding for `guardduty:GetInvestigation`.

Reads an investigation's status, risk details, and results by investigation id.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetInvestigationHttp)`.
### Extended Threat Detection
**Example:** Read an Investigation
```typescript
// init
const getInvestigation = yield* AWS.GuardDuty.GetInvestigation(detector);

// runtime
const { Investigation } = yield* getInvestigation({
  InvestigationId: investigationId,
});
```

@binding

## GetInvitationsCount

Runtime binding for `guardduty:GetInvitationsCount`.

Counts the membership invitations received by this account, excluding deleted ones.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetInvitationsCountHttp)`.
### Administrator & Invitations
**Example:** Count Invitations
```typescript
// init
// init — account-level binding, no resource argument
const getInvitationsCount = yield* AWS.GuardDuty.GetInvitationsCount();

// runtime
const { InvitationsCount } = yield* getInvitationsCount();
```

@binding

## GetMalwareScan

Runtime binding for `guardduty:GetMalwareScan`.

Reads the status and result of an on-demand malware scan by scan id.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetMalwareScanHttp)`.
### Malware Protection
**Example:** Poll a Malware Scan
```typescript
// init
// init — account-level binding, no resource argument
const getMalwareScan = yield* AWS.GuardDuty.GetMalwareScan();

// runtime
const { ScanStatus } = yield* getMalwareScan({ ScanId: scanId });
```

@binding

## GetMalwareScanSettings

Runtime binding for `guardduty:GetMalwareScanSettings`.

Reads the detector's EC2 malware scan settings — scan resource criteria and EBS snapshot preservation.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetMalwareScanSettingsHttp)`.
### Malware Protection
**Example:** Read Malware Scan Settings
```typescript
// init
const getMalwareScanSettings = yield* AWS.GuardDuty.GetMalwareScanSettings(detector);

// runtime
const { ScanResourceCriteria } = yield* getMalwareScanSettings();
```

@binding

## GetMemberDetectors

Runtime binding for `guardduty:GetMemberDetectors`.

Reads the data-source and feature configuration of member detectors.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetMemberDetectorsHttp)`.
### Member Administration
**Example:** Read Member Detector Config
```typescript
// init
const getMemberDetectors = yield* AWS.GuardDuty.GetMemberDetectors(detector);

// runtime
const { MemberDataSourceConfigurations } = yield* getMemberDetectors({
  AccountIds: ["111122223333"],
});
```

@binding

## GetMembers

Runtime binding for `guardduty:GetMembers`.

Reads member account details for the given account ids; unknown accounts come back as `UnprocessedAccounts`.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetMembersHttp)`.
### Member Administration
**Example:** Read Member Details
```typescript
// init
const getMembers = yield* AWS.GuardDuty.GetMembers(detector);

// runtime
const { Members, UnprocessedAccounts } = yield* getMembers({
  AccountIds: ["111122223333"],
});
```

@binding

## GetOrganizationStatistics

Runtime binding for `guardduty:GetOrganizationStatistics`.

Reports organization-wide GuardDuty enablement statistics (delegated administrator only).
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetOrganizationStatisticsHttp)`.
### Organization Administration
**Example:** Read Org Statistics
```typescript
// init
// init — account-level binding, no resource argument
const getOrganizationStatistics = yield* AWS.GuardDuty.GetOrganizationStatistics();

// runtime
const { OrganizationDetails } = yield* getOrganizationStatistics();
```

@binding

## GetRemainingFreeTrialDays

Runtime binding for `guardduty:GetRemainingFreeTrialDays`.

Reports the remaining free-trial days per data source for the given member account ids.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetRemainingFreeTrialDaysHttp)`.
### Usage & Coverage
**Example:** Check Free-Trial Days
```typescript
// init
const getRemainingFreeTrialDays = yield* AWS.GuardDuty.GetRemainingFreeTrialDays(detector);

// runtime
const { Accounts } = yield* getRemainingFreeTrialDays({
  AccountIds: ["111122223333"],
});
```

@binding

## GetUsageStatistics

Runtime binding for `guardduty:GetUsageStatistics`.

Reports GuardDuty usage (cost) statistics for the detector, grouped by data source, feature, or member account.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.GetUsageStatisticsHttp)`.
### Usage & Coverage
**Example:** Usage by Data Source
```typescript
// init
const getUsageStatistics = yield* AWS.GuardDuty.GetUsageStatistics(detector);

// runtime
const { UsageStatistics } = yield* getUsageStatistics({
  UsageStatisticType: "SUM_BY_DATA_SOURCE",
  UsageCriteria: { DataSources: ["FLOW_LOGS"] },
});
```

@binding

## InviteMembers

Runtime binding for `guardduty:InviteMembers`.

Invites member accounts (created via `CreateMembers`) to enable GuardDuty under this administrator.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.InviteMembersHttp)`.
### Member Administration
**Example:** Invite Members
```typescript
// init
const inviteMembers = yield* AWS.GuardDuty.InviteMembers(detector);

// runtime
yield* inviteMembers({
  AccountIds: ["111122223333"],
  Message: "Please enable GuardDuty",
});
```

@binding

## ListCoverage

Runtime binding for `guardduty:ListCoverage`.

Enumerates per-resource coverage details — which EKS clusters, EC2 instances, and ECS clusters report runtime telemetry and why any are unhealthy.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.ListCoverageHttp)`.
### Usage & Coverage
**Example:** List Coverage Details
```typescript
// init
const listCoverage = yield* AWS.GuardDuty.ListCoverage(detector);

// runtime
const { Resources } = yield* listCoverage();
```

@binding

## ListFindings

Runtime binding for `guardduty:ListFindings`.

Lists finding ids for the detector, with optional finding criteria and sort order — the entry point for a findings-triage automation.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.ListFindingsHttp)`.
### Working with Findings
**Example:** List Current Finding Ids
```typescript
// init
const listFindings = yield* AWS.GuardDuty.ListFindings(detector);

// runtime
const { FindingIds } = yield* listFindings();
```

@binding

## ListInvestigations

Runtime binding for `guardduty:ListInvestigations`.

Lists the detector's investigations with optional sort criteria.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.ListInvestigationsHttp)`.
### Extended Threat Detection
**Example:** List Investigations
```typescript
// init
const listInvestigations = yield* AWS.GuardDuty.ListInvestigations(detector);

// runtime
const { Investigations } = yield* listInvestigations();
```

@binding

## ListInvitations

Runtime binding for `guardduty:ListInvitations`.

Lists GuardDuty membership invitations *received by this account* — ready for an automation that auto-accepts invitations from the security account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.ListInvitationsHttp)`.
### Administrator & Invitations
**Example:** List Pending Invitations
```typescript
// init
// init — account-level binding, no resource argument
const listInvitations = yield* AWS.GuardDuty.ListInvitations();

// runtime
const { Invitations } = yield* listInvitations();
```

@binding

## ListMalwareScans

Runtime binding for `guardduty:ListMalwareScans`.

Lists the account's on-demand malware scans with optional filter and sort criteria.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.ListMalwareScansHttp)`.
### Malware Protection
**Example:** List On-Demand Scans
```typescript
// init
// init — account-level binding, no resource argument
const listMalwareScans = yield* AWS.GuardDuty.ListMalwareScans();

// runtime
const { Scans } = yield* listMalwareScans();
```

@binding

## ListMembers

Runtime binding for `guardduty:ListMembers`.

Enumerates the member accounts associated with this administrator detector.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.ListMembersHttp)`.
### Member Administration
**Example:** List Member Accounts
```typescript
// init
const listMembers = yield* AWS.GuardDuty.ListMembers(detector);

// runtime
const { Members } = yield* listMembers();
```

@binding

## ListOrganizationAdminAccounts

Runtime binding for `guardduty:ListOrganizationAdminAccounts`.

Lists the accounts delegated as GuardDuty administrator for the organization.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.ListOrganizationAdminAccountsHttp)`.
### Organization Administration
**Example:** List Delegated Administrators
```typescript
// init
// init — account-level binding, no resource argument
const listOrganizationAdminAccounts = yield* AWS.GuardDuty.ListOrganizationAdminAccounts();

// runtime
const { AdminAccounts } = yield* listOrganizationAdminAccounts();
```

@binding

## SendObjectMalwareScan

Runtime binding for `guardduty:SendObjectMalwareScan`.

Submits an S3 object for malware scanning under a Malware Protection plan covering its bucket.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.SendObjectMalwareScanHttp)`.
### Malware Protection
**Example:** Scan an S3 Object
```typescript
// init
// init — account-level binding, no resource argument
const sendObjectMalwareScan = yield* AWS.GuardDuty.SendObjectMalwareScan();

// runtime
yield* sendObjectMalwareScan({
  S3Object: { Bucket: "my-bucket", Key: "upload.bin" },
});
```

@binding

## StartMalwareScan

Runtime binding for `guardduty:StartMalwareScan`.

Starts an on-demand malware scan of an EC2 instance by ARN (GuardDuty Malware Protection for EC2).
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.StartMalwareScanHttp)`.
### Malware Protection
**Example:** Scan an EC2 Instance
```typescript
// init
// init — account-level binding, no resource argument
const startMalwareScan = yield* AWS.GuardDuty.StartMalwareScan();

// runtime
const { ScanId } = yield* startMalwareScan({
  ResourceArn: instanceArn,
});
```

@binding

## StartMonitoringMembers

Runtime binding for `guardduty:StartMonitoringMembers`.

Resumes GuardDuty monitoring for member accounts previously stopped with `StopMonitoringMembers`.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.StartMonitoringMembersHttp)`.
### Member Administration
**Example:** Resume Monitoring
```typescript
// init
const startMonitoringMembers = yield* AWS.GuardDuty.StartMonitoringMembers(detector);

// runtime
yield* startMonitoringMembers({ AccountIds: ["111122223333"] });
```

@binding

## StopMonitoringMembers

Runtime binding for `guardduty:StopMonitoringMembers`.

Pauses GuardDuty monitoring for the given member accounts.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.StopMonitoringMembersHttp)`.
### Member Administration
**Example:** Pause Monitoring
```typescript
// init
const stopMonitoringMembers = yield* AWS.GuardDuty.StopMonitoringMembers(detector);

// runtime
yield* stopMonitoringMembers({ AccountIds: ["111122223333"] });
```

@binding

## UnarchiveFindings

Runtime binding for `guardduty:UnarchiveFindings`.

Restores archived findings back into the detector's active queue.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.UnarchiveFindingsHttp)`.
### Working with Findings
**Example:** Unarchive Findings
```typescript
// init
const unarchiveFindings = yield* AWS.GuardDuty.UnarchiveFindings(detector);

// runtime
yield* unarchiveFindings({ FindingIds: findingIds });
```

@binding

## UpdateFindingsFeedback

Runtime binding for `guardduty:UpdateFindingsFeedback`.

Marks findings as `USEFUL` or `NOT_USEFUL` to tune GuardDuty's signal quality.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.UpdateFindingsFeedbackHttp)`.
### Working with Findings
**Example:** Mark Findings Useful
```typescript
// init
const updateFindingsFeedback = yield* AWS.GuardDuty.UpdateFindingsFeedback(detector);

// runtime
yield* updateFindingsFeedback({
  FindingIds: findingIds,
  Feedback: "USEFUL",
});
```

@binding

## UpdateMalwareScanSettings

Runtime binding for `guardduty:UpdateMalwareScanSettings`.

Updates the detector's EC2 malware scan settings (scan inclusion/exclusion tags, snapshot retention).
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.UpdateMalwareScanSettingsHttp)`.
### Malware Protection
**Example:** Retain Snapshots with Findings
```typescript
// init
const updateMalwareScanSettings = yield* AWS.GuardDuty.UpdateMalwareScanSettings(detector);

// runtime
yield* updateMalwareScanSettings({
  EbsSnapshotPreservation: "RETENTION_WITH_FINDING",
});
```

@binding

## UpdateMemberDetectors

Runtime binding for `guardduty:UpdateMemberDetectors`.

Updates the feature configuration of member detectors from the administrator account.
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.UpdateMemberDetectorsHttp)`.
### Member Administration
**Example:** Enable a Feature for Members
```typescript
// init
const updateMemberDetectors = yield* AWS.GuardDuty.UpdateMemberDetectors(detector);

// runtime
yield* updateMemberDetectors({
  AccountIds: ["111122223333"],
  Features: [{ Name: "S3_DATA_EVENTS", Status: "ENABLED" }],
});
```

@binding

## UpdateOrganizationConfiguration

Runtime binding for `guardduty:UpdateOrganizationConfiguration`.

Updates the organization's GuardDuty auto-enable configuration (delegated administrator only).
The detector id is injected from the bound {@link Detector}.
Provide the implementation with
`Effect.provide(AWS.GuardDuty.UpdateOrganizationConfigurationHttp)`.
### Organization Administration
**Example:** Auto-Enable New Accounts
```typescript
// init
const updateOrganizationConfiguration = yield* AWS.GuardDuty.UpdateOrganizationConfiguration(detector);

// runtime
yield* updateOrganizationConfiguration({
  AutoEnableOrganizationMembers: "NEW",
});
```

@binding
