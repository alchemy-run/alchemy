<!-- Docs for the generated AWS.Macie2 bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AcceptInvitation

Runtime binding for `macie2:AcceptInvitation`.

Accepts an Amazon Macie membership invitation that was received from a specific account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.AcceptInvitationHttp)`.
### Administrator & Invitations
**Example:** Accept an Administrator's Invitation
```typescript
// init — account-level binding, no resource argument
const acceptInvitation = yield* AWS.Macie2.AcceptInvitation();

// runtime
yield* acceptInvitation({ administratorAccountId, invitationId });
```

@binding

## BatchGetCustomDataIdentifiers

Runtime binding for `macie2:BatchGetCustomDataIdentifiers`.

Retrieves information about one or more custom data identifiers.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.BatchGetCustomDataIdentifiersHttp)`.
### Custom Data Identifiers & Lists
**Example:** Hydrate Custom Data Identifiers
```typescript
// init — account-level binding, no resource argument
const batchGetCustomDataIdentifiers = yield* AWS.Macie2.BatchGetCustomDataIdentifiers();

// runtime
const { customDataIdentifiers } = yield* batchGetCustomDataIdentifiers({ ids });
```

@binding

## BatchUpdateAutomatedDiscoveryAccounts

Runtime binding for `macie2:BatchUpdateAutomatedDiscoveryAccounts`.

Changes the status of automated sensitive data discovery for one or more accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.BatchUpdateAutomatedDiscoveryAccountsHttp)`.
### Automated Discovery
**Example:** Toggle Automated Discovery per Account
```typescript
// init — account-level binding, no resource argument
const batchUpdateAutomatedDiscoveryAccounts = yield* AWS.Macie2.BatchUpdateAutomatedDiscoveryAccounts();

// runtime
yield* batchUpdateAutomatedDiscoveryAccounts({
  accounts: [{ accountId, status: "ENABLED" }],
});
```

@binding

## CreateInvitations

Runtime binding for `macie2:CreateInvitations`.

Sends an Amazon Macie membership invitation to one or more accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.CreateInvitationsHttp)`.
### Administrator & Invitations
**Example:** Invite Member Accounts
```typescript
// init — account-level binding, no resource argument
const createInvitations = yield* AWS.Macie2.CreateInvitations();

// runtime
const { unprocessedAccounts } = yield* createInvitations({ accountIds });
```

@binding

## CreateMember

Runtime binding for `macie2:CreateMember`.

Associates an account with an Amazon Macie administrator account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.CreateMemberHttp)`.
### Organization & Members
**Example:** Associate a Member Account
```typescript
// init — account-level binding, no resource argument
const createMember = yield* AWS.Macie2.CreateMember();

// runtime
yield* createMember({ account: { accountId, email } });
```

@binding

## CreateSampleFindings

Runtime binding for `macie2:CreateSampleFindings`.

Creates sample findings.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.CreateSampleFindingsHttp)`.
### Working with Findings
**Example:** Generate Sample Findings
```typescript
// init — account-level binding, no resource argument
const createSampleFindings = yield* AWS.Macie2.CreateSampleFindings();

// runtime
yield* createSampleFindings({});
```

@binding

## DeclineInvitations

Runtime binding for `macie2:DeclineInvitations`.

Declines Amazon Macie membership invitations that were received from specific accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.DeclineInvitationsHttp)`.
### Administrator & Invitations
**Example:** Decline Invitations
```typescript
// init — account-level binding, no resource argument
const declineInvitations = yield* AWS.Macie2.DeclineInvitations();

// runtime
yield* declineInvitations({ accountIds });
```

@binding

## DeleteInvitations

Runtime binding for `macie2:DeleteInvitations`.

Deletes Amazon Macie membership invitations that were received from specific accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.DeleteInvitationsHttp)`.
### Administrator & Invitations
**Example:** Delete Received Invitations
```typescript
// init — account-level binding, no resource argument
const deleteInvitations = yield* AWS.Macie2.DeleteInvitations();

// runtime
yield* deleteInvitations({ accountIds });
```

@binding

## DeleteMember

Runtime binding for `macie2:DeleteMember`.

Deletes the association between an Amazon Macie administrator account and an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.DeleteMemberHttp)`.
### Organization & Members
**Example:** Delete a Member Association
```typescript
// init — account-level binding, no resource argument
const deleteMember = yield* AWS.Macie2.DeleteMember();

// runtime
yield* deleteMember({ id: accountId });
```

@binding

## DescribeBuckets

Runtime binding for `macie2:DescribeBuckets`.

Retrieves (queries) statistical data and other information about one or more S3 buckets that Amazon Macie monitors and analyzes for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.DescribeBucketsHttp)`.
### S3 Bucket Inventory
**Example:** Query Macie's Bucket Inventory
```typescript
// init — account-level binding, no resource argument
const describeBuckets = yield* AWS.Macie2.DescribeBuckets();

// runtime
const { buckets } = yield* describeBuckets({});
```

@binding

## DescribeOrganizationConfiguration

Runtime binding for `macie2:DescribeOrganizationConfiguration`.

Retrieves the Amazon Macie configuration settings for an organization in Organizations.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.DescribeOrganizationConfigurationHttp)`.
### Organization & Members
**Example:** Read the Organization Configuration
```typescript
// init — account-level binding, no resource argument
const describeOrganizationConfiguration = yield* AWS.Macie2.DescribeOrganizationConfiguration();

// runtime
const { autoEnable } = yield* describeOrganizationConfiguration();
```

@binding

## DisableOrganizationAdminAccount

Runtime binding for `macie2:DisableOrganizationAdminAccount`.

Disables an account as the delegated Amazon Macie administrator account for an organization in Organizations.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.DisableOrganizationAdminAccountHttp)`.
### Organization & Members
**Example:** Remove the Delegated Administrator
```typescript
// init — account-level binding, no resource argument
const disableOrganizationAdminAccount = yield* AWS.Macie2.DisableOrganizationAdminAccount();

// runtime
yield* disableOrganizationAdminAccount({ adminAccountId });
```

@binding

## DisassociateFromAdministratorAccount

Runtime binding for `macie2:DisassociateFromAdministratorAccount`.

Disassociates a member account from its Amazon Macie administrator account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.DisassociateFromAdministratorAccountHttp)`.
### Administrator & Invitations
**Example:** Leave the Administrator Account
```typescript
// init — account-level binding, no resource argument
const disassociateFromAdministratorAccount = yield* AWS.Macie2.DisassociateFromAdministratorAccount();

// runtime
yield* disassociateFromAdministratorAccount();
```

@binding

## DisassociateMember

Runtime binding for `macie2:DisassociateMember`.

Disassociates an Amazon Macie administrator account from a member account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.DisassociateMemberHttp)`.
### Organization & Members
**Example:** Disassociate a Member
```typescript
// init — account-level binding, no resource argument
const disassociateMember = yield* AWS.Macie2.DisassociateMember();

// runtime
yield* disassociateMember({ id: accountId });
```

@binding

## EnableOrganizationAdminAccount

Runtime binding for `macie2:EnableOrganizationAdminAccount`.

Designates an account as the delegated Amazon Macie administrator account for an organization in Organizations.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.EnableOrganizationAdminAccountHttp)`.
### Organization & Members
**Example:** Designate the Delegated Administrator
```typescript
// init — account-level binding, no resource argument
const enableOrganizationAdminAccount = yield* AWS.Macie2.EnableOrganizationAdminAccount();

// runtime
yield* enableOrganizationAdminAccount({ adminAccountId });
```

@binding

## GetAdministratorAccount

Runtime binding for `macie2:GetAdministratorAccount`.

Retrieves information about the Amazon Macie administrator account for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetAdministratorAccountHttp)`.
### Administrator & Invitations
**Example:** Read This Account's Administrator
```typescript
// init — account-level binding, no resource argument
const getAdministratorAccount = yield* AWS.Macie2.GetAdministratorAccount();

// runtime
const { administrator } = yield* getAdministratorAccount();
```

@binding

## GetAutomatedDiscoveryConfiguration

Runtime binding for `macie2:GetAutomatedDiscoveryConfiguration`.

Retrieves the configuration settings and status of automated sensitive data discovery for an organization or standalone account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetAutomatedDiscoveryConfigurationHttp)`.
### Automated Discovery
**Example:** Read the Automated Discovery Configuration
```typescript
// init — account-level binding, no resource argument
const getAutomatedDiscoveryConfiguration = yield* AWS.Macie2.GetAutomatedDiscoveryConfiguration();

// runtime
const { status } = yield* getAutomatedDiscoveryConfiguration();
```

@binding

## GetBucketStatistics

Runtime binding for `macie2:GetBucketStatistics`.

Retrieves (queries) aggregated statistical data about all the S3 buckets that Amazon Macie monitors and analyzes for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetBucketStatisticsHttp)`.
### S3 Bucket Inventory
**Example:** Aggregate Bucket Statistics
```typescript
// init — account-level binding, no resource argument
const getBucketStatistics = yield* AWS.Macie2.GetBucketStatistics();

// runtime
const { bucketCount } = yield* getBucketStatistics({});
```

@binding

## GetClassificationExportConfiguration

Runtime binding for `macie2:GetClassificationExportConfiguration`.

Retrieves the configuration settings for storing data classification results.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetClassificationExportConfigurationHttp)`.
### Classification Jobs & Export
**Example:** Read the Export Configuration
```typescript
// init — account-level binding, no resource argument
const getClassificationExportConfiguration = yield* AWS.Macie2.GetClassificationExportConfiguration();

// runtime
const { configuration } = yield* getClassificationExportConfiguration();
```

@binding

## GetClassificationScope

Runtime binding for `macie2:GetClassificationScope`.

Retrieves the classification scope settings for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetClassificationScopeHttp)`.
### Automated Discovery
**Example:** Read a Classification Scope
```typescript
// init — account-level binding, no resource argument
const getClassificationScope = yield* AWS.Macie2.GetClassificationScope();

// runtime
const scope = yield* getClassificationScope({ id: scopeId });
```

@binding

## GetFindingStatistics

Runtime binding for `macie2:GetFindingStatistics`.

Retrieves (queries) aggregated statistical data about findings.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetFindingStatisticsHttp)`.
### Working with Findings
**Example:** Group Findings by Severity
```typescript
// init — account-level binding, no resource argument
const getFindingStatistics = yield* AWS.Macie2.GetFindingStatistics();

// runtime
const { countsByGroup } = yield* getFindingStatistics({ groupBy: "severity.description" });
```

@binding

## GetFindings

Runtime binding for `macie2:GetFindings`.

Retrieves the details of one or more findings.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetFindingsHttp)`.
### Working with Findings
**Example:** Hydrate Finding Details
```typescript
// init — account-level binding, no resource argument
const getFindings = yield* AWS.Macie2.GetFindings();

// runtime
const { findings } = yield* getFindings({ findingIds });
```

@binding

## GetFindingsPublicationConfiguration

Runtime binding for `macie2:GetFindingsPublicationConfiguration`.

Retrieves the configuration settings for publishing findings to Security Hub.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetFindingsPublicationConfigurationHttp)`.
### Publishing Findings
**Example:** Read the Publication Configuration
```typescript
// init — account-level binding, no resource argument
const getFindingsPublicationConfiguration = yield* AWS.Macie2.GetFindingsPublicationConfiguration();

// runtime
const { securityHubConfiguration } = yield* getFindingsPublicationConfiguration();
```

@binding

## GetInvitationsCount

Runtime binding for `macie2:GetInvitationsCount`.

Retrieves the count of Amazon Macie membership invitations that were received by an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetInvitationsCountHttp)`.
### Administrator & Invitations
**Example:** Count Pending Invitations
```typescript
// init — account-level binding, no resource argument
const getInvitationsCount = yield* AWS.Macie2.GetInvitationsCount();

// runtime
const { invitationsCount } = yield* getInvitationsCount();
```

@binding

## GetMember

Runtime binding for `macie2:GetMember`.

Retrieves information about an account that's associated with an Amazon Macie administrator account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetMemberHttp)`.
### Organization & Members
**Example:** Read a Member's Status
```typescript
// init — account-level binding, no resource argument
const getMember = yield* AWS.Macie2.GetMember();

// runtime
const { relationshipStatus } = yield* getMember({ id: accountId });
```

@binding

## GetResourceProfile

Runtime binding for `macie2:GetResourceProfile`.

Retrieves (queries) sensitive data discovery statistics and the sensitivity score for an S3 bucket.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetResourceProfileHttp)`.
### Automated Discovery
**Example:** Read a Bucket's Sensitivity Profile
```typescript
// init — account-level binding, no resource argument
const getResourceProfile = yield* AWS.Macie2.GetResourceProfile();

// runtime
const profile = yield* getResourceProfile({ resourceArn: bucketArn });
```

@binding

## GetRevealConfiguration

Runtime binding for `macie2:GetRevealConfiguration`.

Retrieves the status and configuration settings for retrieving occurrences of sensitive data reported by findings.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetRevealConfigurationHttp)`.
### Retrieving Sensitive Data Samples
**Example:** Read the Reveal Configuration
```typescript
// init — account-level binding, no resource argument
const getRevealConfiguration = yield* AWS.Macie2.GetRevealConfiguration();

// runtime
const { configuration } = yield* getRevealConfiguration();
```

@binding

## GetSensitiveDataOccurrences

Runtime binding for `macie2:GetSensitiveDataOccurrences`.

Retrieves occurrences of sensitive data reported by a finding.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetSensitiveDataOccurrencesHttp)`.
### Retrieving Sensitive Data Samples
**Example:** Retrieve Samples for a Finding
```typescript
// init — account-level binding, no resource argument
const getSensitiveDataOccurrences = yield* AWS.Macie2.GetSensitiveDataOccurrences();

// runtime
const { sensitiveDataOccurrences } = yield* getSensitiveDataOccurrences({ findingId });
```

@binding

## GetSensitiveDataOccurrencesAvailability

Runtime binding for `macie2:GetSensitiveDataOccurrencesAvailability`.

Checks whether occurrences of sensitive data can be retrieved for a finding.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetSensitiveDataOccurrencesAvailabilityHttp)`.
### Retrieving Sensitive Data Samples
**Example:** Check Sample Availability
```typescript
// init — account-level binding, no resource argument
const getSensitiveDataOccurrencesAvailability = yield* AWS.Macie2.GetSensitiveDataOccurrencesAvailability();

// runtime
const { code } = yield* getSensitiveDataOccurrencesAvailability({ findingId });
```

@binding

## GetSensitivityInspectionTemplate

Runtime binding for `macie2:GetSensitivityInspectionTemplate`.

Retrieves the settings for the sensitivity inspection template for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetSensitivityInspectionTemplateHttp)`.
### Automated Discovery
**Example:** Read a Sensitivity Inspection Template
```typescript
// init — account-level binding, no resource argument
const getSensitivityInspectionTemplate = yield* AWS.Macie2.GetSensitivityInspectionTemplate();

// runtime
const template = yield* getSensitivityInspectionTemplate({ id: templateId });
```

@binding

## GetUsageStatistics

Runtime binding for `macie2:GetUsageStatistics`.

Retrieves (queries) quotas and aggregated usage data for one or more accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetUsageStatisticsHttp)`.
### Usage & Quotas
**Example:** Per-Account Usage Statistics
```typescript
// init — account-level binding, no resource argument
const getUsageStatistics = yield* AWS.Macie2.GetUsageStatistics();

// runtime
const { records } = yield* getUsageStatistics({});
```

@binding

## GetUsageTotals

Runtime binding for `macie2:GetUsageTotals`.

Retrieves (queries) aggregated usage data for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.GetUsageTotalsHttp)`.
### Usage & Quotas
**Example:** Aggregated Usage Totals
```typescript
// init — account-level binding, no resource argument
const getUsageTotals = yield* AWS.Macie2.GetUsageTotals();

// runtime
const { usageTotals } = yield* getUsageTotals();
```

@binding

## ListAllowLists

Runtime binding for `macie2:ListAllowLists`.

Retrieves a subset of information about all the allow lists for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListAllowListsHttp)`.
### Custom Data Identifiers & Lists
**Example:** List Allow Lists
```typescript
// init — account-level binding, no resource argument
const listAllowLists = yield* AWS.Macie2.ListAllowLists();

// runtime
const { allowLists } = yield* listAllowLists();
```

@binding

## ListAutomatedDiscoveryAccounts

Runtime binding for `macie2:ListAutomatedDiscoveryAccounts`.

Retrieves the status of automated sensitive data discovery for one or more accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListAutomatedDiscoveryAccountsHttp)`.
### Automated Discovery
**Example:** List Automated Discovery Accounts
```typescript
// init — account-level binding, no resource argument
const listAutomatedDiscoveryAccounts = yield* AWS.Macie2.ListAutomatedDiscoveryAccounts();

// runtime
const { items } = yield* listAutomatedDiscoveryAccounts();
```

@binding

## ListClassificationJobs

Runtime binding for `macie2:ListClassificationJobs`.

Retrieves a subset of information about one or more classification jobs.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListClassificationJobsHttp)`.
### Classification Jobs & Export
**Example:** List Classification Jobs
```typescript
// init — account-level binding, no resource argument
const listClassificationJobs = yield* AWS.Macie2.ListClassificationJobs();

// runtime
const { items } = yield* listClassificationJobs();
```

@binding

## ListClassificationScopes

Runtime binding for `macie2:ListClassificationScopes`.

Retrieves a subset of information about the classification scope for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListClassificationScopesHttp)`.
### Automated Discovery
**Example:** List Classification Scopes
```typescript
// init — account-level binding, no resource argument
const listClassificationScopes = yield* AWS.Macie2.ListClassificationScopes();

// runtime
const { classificationScopes } = yield* listClassificationScopes();
```

@binding

## ListCustomDataIdentifiers

Runtime binding for `macie2:ListCustomDataIdentifiers`.

Retrieves a subset of information about the custom data identifiers for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListCustomDataIdentifiersHttp)`.
### Custom Data Identifiers & Lists
**Example:** List Custom Data Identifiers
```typescript
// init — account-level binding, no resource argument
const listCustomDataIdentifiers = yield* AWS.Macie2.ListCustomDataIdentifiers();

// runtime
const { items } = yield* listCustomDataIdentifiers();
```

@binding

## ListFindings

Runtime binding for `macie2:ListFindings`.

Retrieves a subset of information about one or more findings.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListFindingsHttp)`.
### Working with Findings
**Example:** List Finding Ids
```typescript
// init — account-level binding, no resource argument
const listFindings = yield* AWS.Macie2.ListFindings();

// runtime
const { findingIds } = yield* listFindings();
```

@binding

## ListFindingsFilters

Runtime binding for `macie2:ListFindingsFilters`.

Retrieves a subset of information about all the findings filters for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListFindingsFiltersHttp)`.
### Custom Data Identifiers & Lists
**Example:** List Findings Filters
```typescript
// init — account-level binding, no resource argument
const listFindingsFilters = yield* AWS.Macie2.ListFindingsFilters();

// runtime
const { findingsFilterListItems } = yield* listFindingsFilters();
```

@binding

## ListInvitations

Runtime binding for `macie2:ListInvitations`.

Retrieves information about Amazon Macie membership invitations that were received by an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListInvitationsHttp)`.
### Administrator & Invitations
**Example:** List Pending Invitations
```typescript
// init — account-level binding, no resource argument
const listInvitations = yield* AWS.Macie2.ListInvitations();

// runtime
const { invitations } = yield* listInvitations();
```

@binding

## ListManagedDataIdentifiers

Runtime binding for `macie2:ListManagedDataIdentifiers`.

Retrieves information about all the managed data identifiers that Amazon Macie currently provides.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListManagedDataIdentifiersHttp)`.
### Custom Data Identifiers & Lists
**Example:** List Managed Data Identifiers
```typescript
// init — account-level binding, no resource argument
const listManagedDataIdentifiers = yield* AWS.Macie2.ListManagedDataIdentifiers();

// runtime
const { items } = yield* listManagedDataIdentifiers();
```

@binding

## ListMembers

Runtime binding for `macie2:ListMembers`.

Retrieves information about the accounts that are associated with an Amazon Macie administrator account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListMembersHttp)`.
### Organization & Members
**Example:** List Member Accounts
```typescript
// init — account-level binding, no resource argument
const listMembers = yield* AWS.Macie2.ListMembers();

// runtime
const { members } = yield* listMembers();
```

@binding

## ListOrganizationAdminAccounts

Runtime binding for `macie2:ListOrganizationAdminAccounts`.

Retrieves information about the delegated Amazon Macie administrator account for an organization in Organizations.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListOrganizationAdminAccountsHttp)`.
### Organization & Members
**Example:** List Delegated Administrators
```typescript
// init — account-level binding, no resource argument
const listOrganizationAdminAccounts = yield* AWS.Macie2.ListOrganizationAdminAccounts();

// runtime
const { adminAccounts } = yield* listOrganizationAdminAccounts();
```

@binding

## ListResourceProfileArtifacts

Runtime binding for `macie2:ListResourceProfileArtifacts`.

Retrieves information about objects that Amazon Macie selected from an S3 bucket for automated sensitive data discovery.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListResourceProfileArtifactsHttp)`.
### Automated Discovery
**Example:** List a Profile's Analyzed Objects
```typescript
// init — account-level binding, no resource argument
const listResourceProfileArtifacts = yield* AWS.Macie2.ListResourceProfileArtifacts();

// runtime
const { artifacts } = yield* listResourceProfileArtifacts({ resourceArn: bucketArn });
```

@binding

## ListResourceProfileDetections

Runtime binding for `macie2:ListResourceProfileDetections`.

Retrieves information about the types and amount of sensitive data that Amazon Macie found in an S3 bucket.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListResourceProfileDetectionsHttp)`.
### Automated Discovery
**Example:** List a Profile's Detections
```typescript
// init — account-level binding, no resource argument
const listResourceProfileDetections = yield* AWS.Macie2.ListResourceProfileDetections();

// runtime
const { detections } = yield* listResourceProfileDetections({ resourceArn: bucketArn });
```

@binding

## ListSensitivityInspectionTemplates

Runtime binding for `macie2:ListSensitivityInspectionTemplates`.

Retrieves a subset of information about the sensitivity inspection template for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.ListSensitivityInspectionTemplatesHttp)`.
### Automated Discovery
**Example:** List Inspection Templates
```typescript
// init — account-level binding, no resource argument
const listSensitivityInspectionTemplates = yield* AWS.Macie2.ListSensitivityInspectionTemplates();

// runtime
const { sensitivityInspectionTemplates } = yield* listSensitivityInspectionTemplates();
```

@binding

## PutClassificationExportConfiguration

Runtime binding for `macie2:PutClassificationExportConfiguration`.

Adds or updates the configuration settings for storing data classification results.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.PutClassificationExportConfigurationHttp)`.
### Classification Jobs & Export
**Example:** Export Results to S3
```typescript
// init — account-level binding, no resource argument
const putClassificationExportConfiguration = yield* AWS.Macie2.PutClassificationExportConfiguration();

// runtime
yield* putClassificationExportConfiguration({
  configuration: {
    s3Destination: { bucketName, keyPrefix: "macie/", kmsKeyArn },
  },
});
```

@binding

## PutFindingsPublicationConfiguration

Runtime binding for `macie2:PutFindingsPublicationConfiguration`.

Updates the configuration settings for publishing findings to Security Hub.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.PutFindingsPublicationConfigurationHttp)`.
### Publishing Findings
**Example:** Publish Policy Findings to Security Hub
```typescript
// init — account-level binding, no resource argument
const putFindingsPublicationConfiguration = yield* AWS.Macie2.PutFindingsPublicationConfiguration();

// runtime
yield* putFindingsPublicationConfiguration({
  securityHubConfiguration: {
    publishClassificationFindings: false,
    publishPolicyFindings: true,
  },
});
```

@binding

## SearchResources

Runtime binding for `macie2:SearchResources`.

Retrieves (queries) statistical data and other information about Amazon Web Services resources that Amazon Macie monitors and analyzes for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.SearchResourcesHttp)`.
### S3 Bucket Inventory
**Example:** Search Buckets by Sensitivity
```typescript
// init — account-level binding, no resource argument
const searchResources = yield* AWS.Macie2.SearchResources();

// runtime
const { matchingResources } = yield* searchResources({});
```

@binding

## TestCustomDataIdentifier

Runtime binding for `macie2:TestCustomDataIdentifier`.

Tests criteria for a custom data identifier.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.TestCustomDataIdentifierHttp)`.
### Custom Data Identifiers & Lists
**Example:** Test a Detection Regex
```typescript
// init — account-level binding, no resource argument
const testCustomDataIdentifier = yield* AWS.Macie2.TestCustomDataIdentifier();

// runtime
const { matchCount } = yield* testCustomDataIdentifier({
  regex: "EMP-[0-9]{8}",
  sampleText: "id EMP-12345678",
});
```

@binding

## UpdateAutomatedDiscoveryConfiguration

Runtime binding for `macie2:UpdateAutomatedDiscoveryConfiguration`.

Changes the configuration settings and status of automated sensitive data discovery for an organization or standalone account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.UpdateAutomatedDiscoveryConfigurationHttp)`.
### Automated Discovery
**Example:** Enable Automated Discovery
```typescript
// init — account-level binding, no resource argument
const updateAutomatedDiscoveryConfiguration = yield* AWS.Macie2.UpdateAutomatedDiscoveryConfiguration();

// runtime
yield* updateAutomatedDiscoveryConfiguration({ status: "ENABLED" });
```

@binding

## UpdateClassificationScope

Runtime binding for `macie2:UpdateClassificationScope`.

Updates the classification scope settings for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.UpdateClassificationScopeHttp)`.
### Automated Discovery
**Example:** Exclude Buckets from Automated Discovery
```typescript
// init — account-level binding, no resource argument
const updateClassificationScope = yield* AWS.Macie2.UpdateClassificationScope();

// runtime
yield* updateClassificationScope({
  id: scopeId,
  s3: { excludes: { bucketNames: ["logs-bucket"], operation: "ADD" } },
});
```

@binding

## UpdateMemberSession

Runtime binding for `macie2:UpdateMemberSession`.

Enables an Amazon Macie administrator to suspend or re-enable Macie for a member account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.UpdateMemberSessionHttp)`.
### Organization & Members
**Example:** Pause Macie for a Member
```typescript
// init — account-level binding, no resource argument
const updateMemberSession = yield* AWS.Macie2.UpdateMemberSession();

// runtime
yield* updateMemberSession({ id: accountId, status: "PAUSED" });
```

@binding

## UpdateOrganizationConfiguration

Runtime binding for `macie2:UpdateOrganizationConfiguration`.

Updates the Amazon Macie configuration settings for an organization in Organizations.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.UpdateOrganizationConfigurationHttp)`.
### Organization & Members
**Example:** Auto-Enable Macie for New Accounts
```typescript
// init — account-level binding, no resource argument
const updateOrganizationConfiguration = yield* AWS.Macie2.UpdateOrganizationConfiguration();

// runtime
yield* updateOrganizationConfiguration({ autoEnable: true });
```

@binding

## UpdateResourceProfile

Runtime binding for `macie2:UpdateResourceProfile`.

Updates the sensitivity score for an S3 bucket.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.UpdateResourceProfileHttp)`.
### Automated Discovery
**Example:** Override a Bucket's Sensitivity Score
```typescript
// init — account-level binding, no resource argument
const updateResourceProfile = yield* AWS.Macie2.UpdateResourceProfile();

// runtime
yield* updateResourceProfile({ resourceArn: bucketArn, sensitivityScoreOverride: 100 });
```

@binding

## UpdateResourceProfileDetections

Runtime binding for `macie2:UpdateResourceProfileDetections`.

Updates the sensitivity scoring settings for an S3 bucket.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.UpdateResourceProfileDetectionsHttp)`.
### Automated Discovery
**Example:** Suppress a Detection on a Bucket
```typescript
// init — account-level binding, no resource argument
const updateResourceProfileDetections = yield* AWS.Macie2.UpdateResourceProfileDetections();

// runtime
yield* updateResourceProfileDetections({
  resourceArn: bucketArn,
  suppressDataIdentifiers: [{ id: identifierId, type: "MANAGED" }],
});
```

@binding

## UpdateRevealConfiguration

Runtime binding for `macie2:UpdateRevealConfiguration`.

Updates the status and configuration settings for retrieving occurrences of sensitive data reported by findings.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.UpdateRevealConfigurationHttp)`.
### Retrieving Sensitive Data Samples
**Example:** Enable Sample Retrieval
```typescript
// init — account-level binding, no resource argument
const updateRevealConfiguration = yield* AWS.Macie2.UpdateRevealConfiguration();

// runtime
yield* updateRevealConfiguration({
  configuration: { status: "ENABLED" },
});
```

@binding

## UpdateSensitivityInspectionTemplate

Runtime binding for `macie2:UpdateSensitivityInspectionTemplate`.

Updates the settings for the sensitivity inspection template for an account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.Macie2.UpdateSensitivityInspectionTemplateHttp)`.
### Automated Discovery
**Example:** Tune the Inspection Template
```typescript
// init — account-level binding, no resource argument
const updateSensitivityInspectionTemplate = yield* AWS.Macie2.UpdateSensitivityInspectionTemplate();

// runtime
yield* updateSensitivityInspectionTemplate({
  id: templateId,
  includes: { managedDataIdentifierIds: ["CREDIT_CARD_NUMBER"] },
});
```

@binding
