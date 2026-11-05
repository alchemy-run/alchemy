<!-- Docs for the generated AWS.AuditManager bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchCreateDelegationByAssessment

Runtime binding for `auditmanager:BatchCreateDelegationByAssessment`.

Creates a batch of delegations — handing control sets of the bound
assessment to reviewers. Provide the
implementation with `Effect.provide(AWS.AuditManager.BatchCreateDelegationByAssessmentHttp)`.
### Delegations
**Example:** Delegate Control Sets for Review
```typescript
const batchCreateDelegationByAssessment = yield* AWS.AuditManager.BatchCreateDelegationByAssessment(assessment);
const result = yield* batchCreateDelegationByAssessment({
  createDelegationRequests: [{
    roleArn: reviewerRoleArn,
    roleType: "RESOURCE_OWNER",
    controlSetId,
  }],
});
```

@binding

## BatchCreateDelegationByAssessment.Request

`BatchCreateDelegationByAssessment` request with `assessmentId` injected from the bound {@link Assessment}.

## BatchDeleteDelegationByAssessment

Runtime binding for `auditmanager:BatchDeleteDelegationByAssessment`.

Deletes a batch of delegations from the bound assessment. Provide the
implementation with `Effect.provide(AWS.AuditManager.BatchDeleteDelegationByAssessmentHttp)`.
### Delegations
**Example:** Revoke Delegations
```typescript
const batchDeleteDelegationByAssessment = yield* AWS.AuditManager.BatchDeleteDelegationByAssessment(assessment);
const result = yield* batchDeleteDelegationByAssessment({ delegationIds });
```

@binding

## BatchDeleteDelegationByAssessment.Request

`BatchDeleteDelegationByAssessment` request with `assessmentId` injected from the bound {@link Assessment}.

## CreateAssessmentReport

Runtime binding for `auditmanager:CreateAssessmentReport`.

Creates an assessment report — a finalized document generated from
the bound assessment's evidence — in the assessment's S3 destination. Provide the
implementation with `Effect.provide(AWS.AuditManager.CreateAssessmentReportHttp)`.
### Assessment Reports
**Example:** Generate an Assessment Report
```typescript
const createAssessmentReport = yield* AWS.AuditManager.CreateAssessmentReport(assessment);
const result = yield* createAssessmentReport({ name: "quarterly-report" });
```

@binding

## CreateAssessmentReport.Request

`CreateAssessmentReport` request with `assessmentId` injected from the bound {@link Assessment}.

## DeleteAssessmentReport

Runtime binding for `auditmanager:DeleteAssessmentReport`.

Deletes an assessment report from the bound assessment and its S3
destination. Provide the
implementation with `Effect.provide(AWS.AuditManager.DeleteAssessmentReportHttp)`.
### Assessment Reports
**Example:** Delete an Assessment Report
```typescript
const deleteAssessmentReport = yield* AWS.AuditManager.DeleteAssessmentReport(assessment);
const result = yield* deleteAssessmentReport({ assessmentReportId });
```

@binding

## DeleteAssessmentReport.Request

`DeleteAssessmentReport` request with `assessmentId` injected from the bound {@link Assessment}.

## GetAccountStatus

Runtime binding for `auditmanager:GetAccountStatus`.

Gets the registration status of the account in Audit Manager
(`ACTIVE`, `INACTIVE`, or `PENDING_ACTIVATION`). Provide the
implementation with `Effect.provide(AWS.AuditManager.GetAccountStatusHttp)`.
### Account Status
**Example:** Guard on Audit Manager Registration
```typescript
const getAccountStatus = yield* AWS.AuditManager.GetAccountStatus();
const result = yield* getAccountStatus();
```

@binding

## GetAssessmentReportUrl

Runtime binding for `auditmanager:GetAssessmentReportUrl`.

Gets the presigned URL for downloading a generated assessment
report. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetAssessmentReportUrlHttp)`.
### Assessment Reports
**Example:** Presign a Report Download
```typescript
const getAssessmentReportUrl = yield* AWS.AuditManager.GetAssessmentReportUrl(assessment);
const result = yield* getAssessmentReportUrl({ assessmentReportId });
```

@binding

## GetAssessmentReportUrl.Request

`GetAssessmentReportUrl` request with `assessmentId` injected from the bound {@link Assessment}.

## GetChangeLogs

Runtime binding for `auditmanager:GetChangeLogs`.

Lists the changelog — who did what, when — for the bound
assessment, optionally narrowed to a control set or control. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetChangeLogsHttp)`.
### Audit Trail
**Example:** Read the Assessment Changelog
```typescript
const getChangeLogs = yield* AWS.AuditManager.GetChangeLogs(assessment);
const result = yield* getChangeLogs({ maxResults: 20 });
```

@binding

## GetChangeLogs.Request

`GetChangeLogs` request with `assessmentId` injected from the bound {@link Assessment}.

## GetDelegations

Runtime binding for `auditmanager:GetDelegations`.

Lists the delegations assigned to the calling account. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetDelegationsHttp)`.
### Delegations
**Example:** List the Account's Delegations
```typescript
const getDelegations = yield* AWS.AuditManager.GetDelegations();
const result = yield* getDelegations({ maxResults: 20 });
```

@binding

## GetEvidence

Runtime binding for `auditmanager:GetEvidence`.

Gets a single evidence item from the bound assessment. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetEvidenceHttp)`.
### Reading Evidence
**Example:** Get a Single Evidence Item
```typescript
const getEvidence = yield* AWS.AuditManager.GetEvidence(assessment);
const result = yield* getEvidence({ controlSetId, evidenceFolderId, evidenceId });
```

@binding

## GetEvidence.Request

`GetEvidence` request with `assessmentId` injected from the bound {@link Assessment}.

## GetEvidenceByEvidenceFolder

Runtime binding for `auditmanager:GetEvidenceByEvidenceFolder`.

Lists the evidence collected in an evidence folder of the bound
assessment. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetEvidenceByEvidenceFolderHttp)`.
### Reading Evidence
**Example:** List the Evidence in a Folder
```typescript
const getEvidenceByEvidenceFolder = yield* AWS.AuditManager.GetEvidenceByEvidenceFolder(assessment);
const result = yield* getEvidenceByEvidenceFolder({ controlSetId, evidenceFolderId });
```

@binding

## GetEvidenceByEvidenceFolder.Request

`GetEvidenceByEvidenceFolder` request with `assessmentId` injected from the bound {@link Assessment}.

## GetEvidenceFileUploadUrl

Runtime binding for `auditmanager:GetEvidenceFileUploadUrl`.

Creates a presigned Amazon S3 URL that can be used to upload a
manual-evidence file — pair with
{@link BatchImportEvidenceToAssessmentControl} to attach the uploaded
file to a control. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetEvidenceFileUploadUrlHttp)`.
### Manual Evidence
**Example:** Presign a Manual-Evidence Upload
```typescript
const getEvidenceFileUploadUrl = yield* AWS.AuditManager.GetEvidenceFileUploadUrl();
const result = yield* getEvidenceFileUploadUrl({ fileName: "access-review.pdf" });
```

@binding

## GetEvidenceFolder

Runtime binding for `auditmanager:GetEvidenceFolder`.

Gets an evidence folder from the bound assessment. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetEvidenceFolderHttp)`.
### Reading Evidence
**Example:** Get an Evidence Folder
```typescript
const getEvidenceFolder = yield* AWS.AuditManager.GetEvidenceFolder(assessment);
const result = yield* getEvidenceFolder({ controlSetId, evidenceFolderId });
```

@binding

## GetEvidenceFolder.Request

`GetEvidenceFolder` request with `assessmentId` injected from the bound {@link Assessment}.

## GetEvidenceFoldersByAssessment

Runtime binding for `auditmanager:GetEvidenceFoldersByAssessment`.

Lists the evidence folders in the bound assessment. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetEvidenceFoldersByAssessmentHttp)`.
### Reading Evidence
**Example:** List the Assessment's Evidence Folders
```typescript
const getEvidenceFoldersByAssessment = yield* AWS.AuditManager.GetEvidenceFoldersByAssessment(assessment);
const result = yield* getEvidenceFoldersByAssessment({ maxResults: 20 });
```

@binding

## GetEvidenceFoldersByAssessment.Request

`GetEvidenceFoldersByAssessment` request with `assessmentId` injected from the bound {@link Assessment}.

## GetInsights

Runtime binding for `auditmanager:GetInsights`.

Gets the latest analytics data for all active assessments —
compliance-check counts by status across the account. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetInsightsHttp)`.
### Insights
**Example:** Account-Wide Evidence Insights
```typescript
const getInsights = yield* AWS.AuditManager.GetInsights();
const result = yield* getInsights();
```

@binding

## GetInsightsByAssessment

Runtime binding for `auditmanager:GetInsightsByAssessment`.

Gets the latest analytics data for the bound assessment. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetInsightsByAssessmentHttp)`.
### Insights
**Example:** Insights for the Bound Assessment
```typescript
const getInsightsByAssessment = yield* AWS.AuditManager.GetInsightsByAssessment(assessment);
const result = yield* getInsightsByAssessment();
```

@binding

## GetInsightsByAssessment.Request

`GetInsightsByAssessment` request with `assessmentId` injected from the bound {@link Assessment}.

## GetServicesInScope

Runtime binding for `auditmanager:GetServicesInScope`.

Lists the AWS services that Audit Manager can include in the scope
of an assessment. Provide the
implementation with `Effect.provide(AWS.AuditManager.GetServicesInScopeHttp)`.
### Account Status
**Example:** List Services Audit Manager Can Assess
```typescript
const getServicesInScope = yield* AWS.AuditManager.GetServicesInScope();
const result = yield* getServicesInScope();
```

@binding

## ListAssessmentReports

Runtime binding for `auditmanager:ListAssessmentReports`.

Lists the assessment reports created in the account. Provide the
implementation with `Effect.provide(AWS.AuditManager.ListAssessmentReportsHttp)`.
### Assessment Reports
**Example:** List Assessment Reports
```typescript
const listAssessmentReports = yield* AWS.AuditManager.ListAssessmentReports();
const result = yield* listAssessmentReports({ maxResults: 20 });
```

@binding

## ListControlDomainInsights

Runtime binding for `auditmanager:ListControlDomainInsights`.

Lists the latest analytics data for control domains across all
active assessments. Provide the
implementation with `Effect.provide(AWS.AuditManager.ListControlDomainInsightsHttp)`.
### Insights
**Example:** Control-Domain Insights Across Assessments
```typescript
const listControlDomainInsights = yield* AWS.AuditManager.ListControlDomainInsights();
const result = yield* listControlDomainInsights({ maxResults: 20 });
```

@binding

## ListControlInsightsByControlDomain

Runtime binding for `auditmanager:ListControlInsightsByControlDomain`.

Lists the latest control analytics for a specific control domain
across active assessments. Provide the
implementation with `Effect.provide(AWS.AuditManager.ListControlInsightsByControlDomainHttp)`.
### Insights
**Example:** Control Insights for a Domain
```typescript
const listControlInsightsByControlDomain = yield* AWS.AuditManager.ListControlInsightsByControlDomain();
const result = yield* listControlInsightsByControlDomain({ controlDomainId });
```

@binding

## ListKeywordsForDataSource

Runtime binding for `auditmanager:ListKeywordsForDataSource`.

Lists the keywords that are pre-mapped to the specified control
data source (CloudTrail event names, Config rules, Security Hub
controls, …). Provide the
implementation with `Effect.provide(AWS.AuditManager.ListKeywordsForDataSourceHttp)`.
### Control Data Sources
**Example:** Keywords for a Data Source
```typescript
const listKeywordsForDataSource = yield* AWS.AuditManager.ListKeywordsForDataSource();
const result = yield* listKeywordsForDataSource({ source: "AWS_Cloudtrail" });
```

@binding

## ListNotifications

Runtime binding for `auditmanager:ListNotifications`.

Lists the notifications for the account — delegation requests,
control-set review handoffs, and completed report generation. Provide the
implementation with `Effect.provide(AWS.AuditManager.ListNotificationsHttp)`.
### Notifications
**Example:** List Audit Manager Notifications
```typescript
const listNotifications = yield* AWS.AuditManager.ListNotifications();
const result = yield* listNotifications({ maxResults: 20 });
```

@binding

## UpdateAssessmentControl

Runtime binding for `auditmanager:UpdateAssessmentControl`.

Updates a control within the bound assessment — sets its review
status and/or adds a comment. Provide the
implementation with `Effect.provide(AWS.AuditManager.UpdateAssessmentControlHttp)`.
### Assessment Workflow
**Example:** Set a Control's Review Status
```typescript
const updateAssessmentControl = yield* AWS.AuditManager.UpdateAssessmentControl(assessment);
const result = yield* updateAssessmentControl({ controlSetId, controlId, controlStatus: "REVIEWED" });
```

@binding

## UpdateAssessmentControl.Request

`UpdateAssessmentControl` request with `assessmentId` injected from the bound {@link Assessment}.

## UpdateAssessmentControlSetStatus

Runtime binding for `auditmanager:UpdateAssessmentControlSetStatus`.

Updates the review status of a control set in the bound
assessment. Provide the
implementation with `Effect.provide(AWS.AuditManager.UpdateAssessmentControlSetStatusHttp)`.
### Assessment Workflow
**Example:** Sign Off a Control Set
```typescript
const updateAssessmentControlSetStatus = yield* AWS.AuditManager.UpdateAssessmentControlSetStatus(assessment);
const result = yield* updateAssessmentControlSetStatus({ controlSetId, status: "REVIEWED", comment: "Signed off" });
```

@binding

## UpdateAssessmentControlSetStatus.Request

`UpdateAssessmentControlSetStatus` request with `assessmentId` injected from the bound {@link Assessment}.

## UpdateAssessmentStatus

Runtime binding for `auditmanager:UpdateAssessmentStatus`.

Sets the bound assessment's status — mark it `INACTIVE` to
complete it and stop evidence collection. Provide the
implementation with `Effect.provide(AWS.AuditManager.UpdateAssessmentStatusHttp)`.
### Assessment Workflow
**Example:** Complete an Assessment
```typescript
const updateAssessmentStatus = yield* AWS.AuditManager.UpdateAssessmentStatus(assessment);
const result = yield* updateAssessmentStatus({ status: "INACTIVE" });
```

@binding

## UpdateAssessmentStatus.Request

`UpdateAssessmentStatus` request with `assessmentId` injected from the bound {@link Assessment}.

## ValidateAssessmentReportIntegrity

Runtime binding for `auditmanager:ValidateAssessmentReportIntegrity`.

Validates the integrity (checksums) of a generated assessment
report in Amazon S3. Provide the
implementation with `Effect.provide(AWS.AuditManager.ValidateAssessmentReportIntegrityHttp)`.
### Assessment Reports
**Example:** Validate a Generated Report
```typescript
const validateAssessmentReportIntegrity = yield* AWS.AuditManager.ValidateAssessmentReportIntegrity();
const result = yield* validateAssessmentReportIntegrity({ s3RelativePath: "s3://audit-reports/report.zip" });
```

@binding
