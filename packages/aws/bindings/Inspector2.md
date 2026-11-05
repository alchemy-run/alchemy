<!-- Docs for the generated AWS.Inspector2 bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AssociateMember

Runtime binding for `inspector2:AssociateMember`.

Associates an Amazon Web Services account with an Amazon Inspector delegated administrator. An HTTP 200 response
indicates the association was successfully started, but doesn’t indicate whether it was
completed. You can check if the association completed by using ListMembers for multiple
accounts or GetMembers for a single account.

Provide the implementation with
`Effect.provide(AWS.Inspector2.AssociateMemberHttp)`.
### Organization & Members
**Example:** Associate a Member Account
```typescript
// init
const associateMember = yield* AWS.Inspector2.AssociateMember();

// runtime
yield* associateMember({ accountId });
```

@binding

## BatchGetCodeSnippet

Runtime binding for `inspector2:BatchGetCodeSnippet`.

Retrieves code snippets from findings that Amazon Inspector detected code vulnerabilities
in.

Provide the implementation with
`Effect.provide(AWS.Inspector2.BatchGetCodeSnippetHttp)`.
### Querying Findings
**Example:** Get Code Snippets for Code Findings
```typescript
// init
const batchGetCodeSnippet = yield* AWS.Inspector2.BatchGetCodeSnippet();

// runtime
const { codeSnippetResults } = yield* batchGetCodeSnippet({ findingArns: [findingArn] });
```

@binding

## BatchGetFindingDetails

Runtime binding for `inspector2:BatchGetFindingDetails`.

Gets vulnerability details for findings.

Provide the implementation with
`Effect.provide(AWS.Inspector2.BatchGetFindingDetailsHttp)`.
### Querying Findings
**Example:** Get Finding Details
```typescript
// init
const batchGetFindingDetails = yield* AWS.Inspector2.BatchGetFindingDetails();

// runtime
const { findingDetails } = yield* batchGetFindingDetails({ findingArns: [findingArn] });
```

@binding

## BatchGetFreeTrialInfo

Runtime binding for `inspector2:BatchGetFreeTrialInfo`.

Gets free trial status for multiple Amazon Web Services accounts.

Provide the implementation with
`Effect.provide(AWS.Inspector2.BatchGetFreeTrialInfoHttp)`.
### Account Settings & Usage
**Example:** Free Trial Status
```typescript
// init
const batchGetFreeTrialInfo = yield* AWS.Inspector2.BatchGetFreeTrialInfo();

// runtime
const { accounts } = yield* batchGetFreeTrialInfo({ accountIds: [accountId] });
```

@binding

## BatchGetMemberEc2DeepInspectionStatus

Runtime binding for `inspector2:BatchGetMemberEc2DeepInspectionStatus`.

Retrieves Amazon Inspector deep inspection activation status of multiple member accounts within
your organization. You must be the delegated administrator of an organization in Amazon Inspector to
use this API.

Provide the implementation with
`Effect.provide(AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatusHttp)`.
### Organization & Members
**Example:** Read Members' Deep Inspection Status
```typescript
// init
const batchGetMemberEc2DeepInspectionStatus = yield* AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatus();

// runtime
const { accountIds } = yield* batchGetMemberEc2DeepInspectionStatus();
```

@binding

## BatchUpdateMemberEc2DeepInspectionStatus

Runtime binding for `inspector2:BatchUpdateMemberEc2DeepInspectionStatus`.

Activates or deactivates Amazon Inspector deep inspection for the provided member accounts in your
organization. You must be the delegated administrator of an organization in Amazon Inspector to use
this API.

Provide the implementation with
`Effect.provide(AWS.Inspector2.BatchUpdateMemberEc2DeepInspectionStatusHttp)`.
### Organization & Members
**Example:** Toggle Members' Deep Inspection
```typescript
// init
const batchUpdateMemberEc2DeepInspectionStatus = yield* AWS.Inspector2.BatchUpdateMemberEc2DeepInspectionStatus();

// runtime
const { accountIds } = yield* batchUpdateMemberEc2DeepInspectionStatus({
  accountIds: [{ accountId, activateDeepInspection: true }],
});
```

@binding

## CancelFindingsReport

Runtime binding for `inspector2:CancelFindingsReport`.

Cancels the given findings report.

Provide the implementation with
`Effect.provide(AWS.Inspector2.CancelFindingsReportHttp)`.
### Findings Reports & SBOM Exports
**Example:** Cancel a Findings Report
```typescript
// init
const cancelFindingsReport = yield* AWS.Inspector2.CancelFindingsReport();

// runtime
yield* cancelFindingsReport({ reportId });
```

@binding

## CancelSbomExport

Runtime binding for `inspector2:CancelSbomExport`.

Cancels a software bill of materials (SBOM) report.

Provide the implementation with
`Effect.provide(AWS.Inspector2.CancelSbomExportHttp)`.
### Findings Reports & SBOM Exports
**Example:** Cancel an SBOM Export
```typescript
// init
const cancelSbomExport = yield* AWS.Inspector2.CancelSbomExport();

// runtime
yield* cancelSbomExport({ reportId });
```

@binding

## CreateFindingsReport

Runtime binding for `inspector2:CreateFindingsReport`.

Creates a finding report. By default only `ACTIVE` findings are returned in
the report. To see `SUPRESSED` or `CLOSED` findings you must specify
a value for the `findingStatus` filter criteria.

Provide the implementation with
`Effect.provide(AWS.Inspector2.CreateFindingsReportHttp)`.
### Findings Reports & SBOM Exports
**Example:** Export Findings to S3
```typescript
// init
const createFindingsReport = yield* AWS.Inspector2.CreateFindingsReport();

// runtime
const { reportId } = yield* createFindingsReport({
  reportFormat: "JSON",
  s3Destination: { bucketName, keyPrefix: "findings/", kmsKeyArn },
});
```

@binding

## CreateSbomExport

Runtime binding for `inspector2:CreateSbomExport`.

Creates a software bill of materials (SBOM) report.

Provide the implementation with
`Effect.provide(AWS.Inspector2.CreateSbomExportHttp)`.
### Findings Reports & SBOM Exports
**Example:** Export an SBOM
```typescript
// init
const createSbomExport = yield* AWS.Inspector2.CreateSbomExport();

// runtime
const { reportId } = yield* createSbomExport({
  reportFormat: "SPDX_2_3",
  s3Destination: { bucketName, keyPrefix: "sbom/", kmsKeyArn },
});
```

@binding

## DescribeOrganizationConfiguration

Runtime binding for `inspector2:DescribeOrganizationConfiguration`.

Describe Amazon Inspector configuration settings for an Amazon Web Services organization.

Provide the implementation with
`Effect.provide(AWS.Inspector2.DescribeOrganizationConfigurationHttp)`.
### Organization & Members
**Example:** Read Organization Auto-Enable Settings
```typescript
// init
const describeOrganizationConfiguration = yield* AWS.Inspector2.DescribeOrganizationConfiguration();

// runtime
const { autoEnable } = yield* describeOrganizationConfiguration();
```

@binding

## DisableDelegatedAdminAccount

Runtime binding for `inspector2:DisableDelegatedAdminAccount`.

Disables the Amazon Inspector delegated administrator for your organization.

Provide the implementation with
`Effect.provide(AWS.Inspector2.DisableDelegatedAdminAccountHttp)`.
### Organization & Members
**Example:** Disable a Delegated Administrator
```typescript
// init
const disableDelegatedAdminAccount = yield* AWS.Inspector2.DisableDelegatedAdminAccount();

// runtime
yield* disableDelegatedAdminAccount({ delegatedAdminAccountId });
```

@binding

## DisassociateMember

Runtime binding for `inspector2:DisassociateMember`.

Disassociates a member account from an Amazon Inspector delegated administrator.

Provide the implementation with
`Effect.provide(AWS.Inspector2.DisassociateMemberHttp)`.
### Organization & Members
**Example:** Disassociate a Member Account
```typescript
// init
const disassociateMember = yield* AWS.Inspector2.DisassociateMember();

// runtime
yield* disassociateMember({ accountId });
```

@binding

## EnableDelegatedAdminAccount

Runtime binding for `inspector2:EnableDelegatedAdminAccount`.

Enables the Amazon Inspector delegated administrator for your Organizations organization.

Provide the implementation with
`Effect.provide(AWS.Inspector2.EnableDelegatedAdminAccountHttp)`.
### Organization & Members
**Example:** Enable a Delegated Administrator
```typescript
// init
const enableDelegatedAdminAccount = yield* AWS.Inspector2.EnableDelegatedAdminAccount();

// runtime
yield* enableDelegatedAdminAccount({ delegatedAdminAccountId });
```

@binding

## GetCisScanReport

Runtime binding for `inspector2:GetCisScanReport`.

Retrieves a CIS scan report.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetCisScanReportHttp)`.
### CIS Scan Results
**Example:** Download a CIS Scan Report
```typescript
// init
const getCisScanReport = yield* AWS.Inspector2.GetCisScanReport();

// runtime
const { url, status } = yield* getCisScanReport({ scanArn });
```

@binding

## GetCisScanResultDetails

Runtime binding for `inspector2:GetCisScanResultDetails`.

Retrieves CIS scan result details.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetCisScanResultDetailsHttp)`.
### CIS Scan Results
**Example:** CIS Result Details for an Instance
```typescript
// init
const getCisScanResultDetails = yield* AWS.Inspector2.GetCisScanResultDetails();

// runtime
const { scanResultDetails } = yield* getCisScanResultDetails({
  scanArn,
  accountId,
  targetResourceId: instanceId,
});
```

@binding

## GetClustersForImage

Runtime binding for `inspector2:GetClustersForImage`.

Returns a list of clusters and metadata associated with an image.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetClustersForImageHttp)`.
### Coverage & Vulnerability Intel
**Example:** Find Clusters Running an Image
```typescript
// init
const getClustersForImage = yield* AWS.Inspector2.GetClustersForImage();

// runtime
const { cluster } = yield* getClustersForImage({
  filter: { resourceId: imageResourceId },
});
```

@binding

## GetCodeSecurityScan

Runtime binding for `inspector2:GetCodeSecurityScan`.

Retrieves information about a specific code security scan.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetCodeSecurityScanHttp)`.
### Code Security Scans
**Example:** Poll a Code Security Scan
```typescript
// init
const getCodeSecurityScan = yield* AWS.Inspector2.GetCodeSecurityScan();

// runtime
const { status } = yield* getCodeSecurityScan({
  resource: { projectId },
  scanId,
});
```

@binding

## GetConfiguration

Runtime binding for `inspector2:GetConfiguration`.

Retrieves setting configurations for Inspector scans.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetConfigurationHttp)`.
### Account Settings & Usage
**Example:** Read Scan Settings
```typescript
// init
const getConfiguration = yield* AWS.Inspector2.GetConfiguration();

// runtime
const { ecrConfiguration, ec2Configuration } = yield* getConfiguration();
```

@binding

## GetDelegatedAdminAccount

Runtime binding for `inspector2:GetDelegatedAdminAccount`.

Retrieves information about the Amazon Inspector delegated administrator for your
organization.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetDelegatedAdminAccountHttp)`.
### Organization & Members
**Example:** Get the Delegated Administrator
```typescript
// init
const getDelegatedAdminAccount = yield* AWS.Inspector2.GetDelegatedAdminAccount();

// runtime
const { delegatedAdmin } = yield* getDelegatedAdminAccount();
```

@binding

## GetEc2DeepInspectionConfiguration

Runtime binding for `inspector2:GetEc2DeepInspectionConfiguration`.

Retrieves the activation status of Amazon Inspector deep inspection and custom paths associated
with your account.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetEc2DeepInspectionConfigurationHttp)`.
### Account Settings & Usage
**Example:** Read Deep Inspection Settings
```typescript
// init
const getEc2DeepInspectionConfiguration = yield* AWS.Inspector2.GetEc2DeepInspectionConfiguration();

// runtime
const { status, packagePaths } = yield* getEc2DeepInspectionConfiguration();
```

@binding

## GetEncryptionKey

Runtime binding for `inspector2:GetEncryptionKey`.

Gets an encryption key.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetEncryptionKeyHttp)`.
### Account Settings & Usage
**Example:** Read the CMK for a Scan Type
```typescript
// init
const getEncryptionKey = yield* AWS.Inspector2.GetEncryptionKey();

// runtime
const { kmsKeyId } = yield* getEncryptionKey({
  resourceType: "AWS_ECR_CONTAINER_IMAGE",
  scanType: "PACKAGE",
});
```

@binding

## GetFindingsReportStatus

Runtime binding for `inspector2:GetFindingsReportStatus`.

Gets the status of a findings report.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetFindingsReportStatusHttp)`.
### Findings Reports & SBOM Exports
**Example:** Poll a Findings Report
```typescript
// init
const getFindingsReportStatus = yield* AWS.Inspector2.GetFindingsReportStatus();

// runtime
const { status } = yield* getFindingsReportStatus({ reportId });
```

@binding

## GetMember

Runtime binding for `inspector2:GetMember`.

Gets member information for your organization.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetMemberHttp)`.
### Organization & Members
**Example:** Get a Member Account
```typescript
// init
const getMember = yield* AWS.Inspector2.GetMember();

// runtime
const { member } = yield* getMember({ accountId });
```

@binding

## GetSbomExport

Runtime binding for `inspector2:GetSbomExport`.

Gets details of a software bill of materials (SBOM) report.

Provide the implementation with
`Effect.provide(AWS.Inspector2.GetSbomExportHttp)`.
### Findings Reports & SBOM Exports
**Example:** Poll an SBOM Export
```typescript
// init
const getSbomExport = yield* AWS.Inspector2.GetSbomExport();

// runtime
const { status } = yield* getSbomExport({ reportId });
```

@binding

## ListAccountPermissions

Runtime binding for `inspector2:ListAccountPermissions`.

Lists the permissions an account has to configure Amazon Inspector.
If the account is a member account or standalone account with resources managed by an Organizations policy, the operation returns fewer permissions.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListAccountPermissionsHttp)`.
### Account Settings & Usage
**Example:** List Granted Permissions
```typescript
// init
const listAccountPermissions = yield* AWS.Inspector2.ListAccountPermissions();

// runtime
const { permissions } = yield* listAccountPermissions();
```

@binding

## ListCisScanResultsAggregatedByChecks

Runtime binding for `inspector2:ListCisScanResultsAggregatedByChecks`.

Lists scan results aggregated by checks.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListCisScanResultsAggregatedByChecksHttp)`.
### CIS Scan Results
**Example:** CIS Results by Check
```typescript
// init
const listCisScanResultsAggregatedByChecks = yield* AWS.Inspector2.ListCisScanResultsAggregatedByChecks();

// runtime
const { checkAggregations } = yield* listCisScanResultsAggregatedByChecks({ scanArn });
```

@binding

## ListCisScanResultsAggregatedByTargetResource

Runtime binding for `inspector2:ListCisScanResultsAggregatedByTargetResource`.

Lists scan results aggregated by a target resource.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListCisScanResultsAggregatedByTargetResourceHttp)`.
### CIS Scan Results
**Example:** CIS Results by Target Resource
```typescript
// init
const listCisScanResultsAggregatedByTargetResource = yield* AWS.Inspector2.ListCisScanResultsAggregatedByTargetResource();

// runtime
const { targetResourceAggregations } = yield* listCisScanResultsAggregatedByTargetResource({ scanArn });
```

@binding

## ListCisScans

Runtime binding for `inspector2:ListCisScans`.

Returns a CIS scan list.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListCisScansHttp)`.
### CIS Scan Results
**Example:** List Completed CIS Scans
```typescript
// init
const listCisScans = yield* AWS.Inspector2.ListCisScans();

// runtime
const { scans } = yield* listCisScans();
```

@binding

## ListCoverage

Runtime binding for `inspector2:ListCoverage`.

Lists coverage details for your environment.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListCoverageHttp)`.
### Coverage & Vulnerability Intel
**Example:** List Scan Coverage
```typescript
// init
const listCoverage = yield* AWS.Inspector2.ListCoverage();

// runtime
const { coveredResources } = yield* listCoverage();
```

@binding

## ListCoverageStatistics

Runtime binding for `inspector2:ListCoverageStatistics`.

Lists Amazon Inspector coverage statistics for your environment.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListCoverageStatisticsHttp)`.
### Coverage & Vulnerability Intel
**Example:** Coverage Statistics by Resource Type
```typescript
// init
const listCoverageStatistics = yield* AWS.Inspector2.ListCoverageStatistics();

// runtime
const { countsByGroup, totalCounts } = yield* listCoverageStatistics({ groupBy: "RESOURCE_TYPE" });
```

@binding

## ListDelegatedAdminAccounts

Runtime binding for `inspector2:ListDelegatedAdminAccounts`.

Lists information about the Amazon Inspector delegated administrator of your organization.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListDelegatedAdminAccountsHttp)`.
### Organization & Members
**Example:** List Delegated Administrators
```typescript
// init
const listDelegatedAdminAccounts = yield* AWS.Inspector2.ListDelegatedAdminAccounts();

// runtime
const { delegatedAdminAccounts } = yield* listDelegatedAdminAccounts();
```

@binding

## ListFindingAggregations

Runtime binding for `inspector2:ListFindingAggregations`.

Lists aggregated finding data for your environment based on specific criteria.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListFindingAggregationsHttp)`.
### Querying Findings
**Example:** Aggregate Findings by Account
```typescript
// init
const listFindingAggregations = yield* AWS.Inspector2.ListFindingAggregations();

// runtime
const { responses } = yield* listFindingAggregations({ aggregationType: "ACCOUNT" });
```

@binding

## ListFindings

Runtime binding for `inspector2:ListFindings`.

Lists findings for your environment.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListFindingsHttp)`.
### Querying Findings
**Example:** List Critical Findings
```typescript
// init
const listFindings = yield* AWS.Inspector2.ListFindings();

// runtime
const { findings } = yield* listFindings({
  filterCriteria: { severity: [{ comparison: "EQUALS", value: "CRITICAL" }] },
});
```

@binding

## ListMembers

Runtime binding for `inspector2:ListMembers`.

List members associated with the Amazon Inspector delegated administrator for your
organization.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListMembersHttp)`.
### Organization & Members
**Example:** List Member Accounts
```typescript
// init
const listMembers = yield* AWS.Inspector2.ListMembers();

// runtime
const { members } = yield* listMembers();
```

@binding

## ListUsageTotals

Runtime binding for `inspector2:ListUsageTotals`.

Lists the Amazon Inspector usage totals over the last 30 days.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ListUsageTotalsHttp)`.
### Account Settings & Usage
**Example:** Monthly Usage Totals
```typescript
// init
const listUsageTotals = yield* AWS.Inspector2.ListUsageTotals();

// runtime
const { totals } = yield* listUsageTotals();
```

@binding

## ResetEncryptionKey

Runtime binding for `inspector2:ResetEncryptionKey`.

Resets an encryption key. After the key is reset your resources will be encrypted by an
Amazon Web Services owned key.

Provide the implementation with
`Effect.provide(AWS.Inspector2.ResetEncryptionKeyHttp)`.
### Account Settings & Usage
**Example:** Reset to the AWS-Owned Key
```typescript
// init
const resetEncryptionKey = yield* AWS.Inspector2.ResetEncryptionKey();

// runtime
yield* resetEncryptionKey({
  resourceType: "AWS_ECR_CONTAINER_IMAGE",
  scanType: "PACKAGE",
});
```

@binding

## SearchVulnerabilities

Runtime binding for `inspector2:SearchVulnerabilities`.

Lists Amazon Inspector coverage details for a specific vulnerability.

Provide the implementation with
`Effect.provide(AWS.Inspector2.SearchVulnerabilitiesHttp)`.
### Coverage & Vulnerability Intel
**Example:** Look Up a CVE
```typescript
// init
const searchVulnerabilities = yield* AWS.Inspector2.SearchVulnerabilities();

// runtime
const { vulnerabilities } = yield* searchVulnerabilities({
  filterCriteria: { vulnerabilityIds: ["CVE-2021-44228"] },
});
```

@binding

## StartCodeSecurityScan

Runtime binding for `inspector2:StartCodeSecurityScan`.

Initiates a code security scan on a specified repository.

Provide the implementation with
`Effect.provide(AWS.Inspector2.StartCodeSecurityScanHttp)`.
### Code Security Scans
**Example:** Scan a Repository
```typescript
// init
const startCodeSecurityScan = yield* AWS.Inspector2.StartCodeSecurityScan();

// runtime
const { scanId, status } = yield* startCodeSecurityScan({
  resource: { projectId },
});
```

@binding

## UpdateConfiguration

Runtime binding for `inspector2:UpdateConfiguration`.

Updates setting configurations for your Amazon Inspector account. When you use this API as an Amazon Inspector
delegated administrator this updates the setting for all accounts you manage. Member
accounts in an organization cannot update this setting.

Provide the implementation with
`Effect.provide(AWS.Inspector2.UpdateConfigurationHttp)`.
### Account Settings & Usage
**Example:** Tune ECR Rescan Duration
```typescript
// init
const updateConfiguration = yield* AWS.Inspector2.UpdateConfiguration();

// runtime
yield* updateConfiguration({
  ecrConfiguration: { rescanDuration: "DAYS_30" },
});
```

@binding

## UpdateEc2DeepInspectionConfiguration

Runtime binding for `inspector2:UpdateEc2DeepInspectionConfiguration`.

Activates, deactivates Amazon Inspector deep inspection, or updates custom paths for your account.

Provide the implementation with
`Effect.provide(AWS.Inspector2.UpdateEc2DeepInspectionConfigurationHttp)`.
### Account Settings & Usage
**Example:** Activate Deep Inspection
```typescript
// init
const updateEc2DeepInspectionConfiguration = yield* AWS.Inspector2.UpdateEc2DeepInspectionConfiguration();

// runtime
const { status } = yield* updateEc2DeepInspectionConfiguration({ activateDeepInspection: true });
```

@binding

## UpdateEncryptionKey

Runtime binding for `inspector2:UpdateEncryptionKey`.

Updates an encryption key. A `ResourceNotFoundException` means that an
Amazon Web Services owned key is being used for encryption.

Provide the implementation with
`Effect.provide(AWS.Inspector2.UpdateEncryptionKeyHttp)`.
### Account Settings & Usage
**Example:** Use a Customer-Managed Key
```typescript
// init
const updateEncryptionKey = yield* AWS.Inspector2.UpdateEncryptionKey();

// runtime
yield* updateEncryptionKey({
  kmsKeyId,
  resourceType: "AWS_ECR_CONTAINER_IMAGE",
  scanType: "PACKAGE",
});
```

@binding

## UpdateOrgEc2DeepInspectionConfiguration

Runtime binding for `inspector2:UpdateOrgEc2DeepInspectionConfiguration`.

Updates the Amazon Inspector deep inspection custom paths for your organization. You must be an
Amazon Inspector delegated administrator to use this API.

Provide the implementation with
`Effect.provide(AWS.Inspector2.UpdateOrgEc2DeepInspectionConfigurationHttp)`.
### Organization & Members
**Example:** Set Org-Wide Deep Inspection Paths
```typescript
// init
const updateOrgEc2DeepInspectionConfiguration = yield* AWS.Inspector2.UpdateOrgEc2DeepInspectionConfiguration();

// runtime
yield* updateOrgEc2DeepInspectionConfiguration({ orgPackagePaths: ["/opt/app"] });
```

@binding

## UpdateOrganizationConfiguration

Runtime binding for `inspector2:UpdateOrganizationConfiguration`.

Updates the configurations for your Amazon Inspector organization.

Provide the implementation with
`Effect.provide(AWS.Inspector2.UpdateOrganizationConfigurationHttp)`.
### Organization & Members
**Example:** Auto-Enable Scanning for New Members
```typescript
// init
const updateOrganizationConfiguration = yield* AWS.Inspector2.UpdateOrganizationConfiguration();

// runtime
yield* updateOrganizationConfiguration({
  autoEnable: { ec2: true, ecr: true, lambda: true },
});
```

@binding
