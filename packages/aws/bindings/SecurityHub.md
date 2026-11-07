<!-- Docs for the generated AWS.SecurityHub bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AcceptAdministratorInvitation

Runtime binding for `securityhub:AcceptAdministratorInvitation`.

Accepts an invitation to become a member of a Security Hub administrator account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.AcceptAdministratorInvitationHttp)`.
### Members & Organization
**Example:** Accept an Administrator Invitation
```typescript
// init — account-level binding, no resource argument
const acceptAdministratorInvitation = yield* AWS.SecurityHub.AcceptAdministratorInvitation();

// runtime
yield* acceptAdministratorInvitation({
  AdministratorId: adminAccountId,
  InvitationId: invitationId,
});
```

@binding

## BatchDisableStandards

Runtime binding for `securityhub:BatchDisableStandards`.

Disables (unsubscribes the account from) one or more security standards.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.BatchDisableStandardsHttp)`.
### Standards & Controls
**Example:** Disable a Standard
```typescript
// init — account-level binding, no resource argument
const batchDisableStandards = yield* AWS.SecurityHub.BatchDisableStandards();

// runtime
yield* batchDisableStandards({
  StandardsSubscriptionArns: [subscriptionArn],
});
```

@binding

## BatchEnableStandards

Runtime binding for `securityhub:BatchEnableStandards`.

Enables (subscribes the account to) one or more security standards.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.BatchEnableStandardsHttp)`.
### Standards & Controls
**Example:** Enable a Standard
```typescript
// init — account-level binding, no resource argument
const batchEnableStandards = yield* AWS.SecurityHub.BatchEnableStandards();

// runtime
yield* batchEnableStandards({
  StandardsSubscriptionRequests: [{ StandardsArn: standardsArn }],
});
```

@binding

## BatchGetAutomationRules

Runtime binding for `securityhub:BatchGetAutomationRules`.

Returns the full configuration of a batch of automation rules by ARN.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.BatchGetAutomationRulesHttp)`.
### Custom Actions, Automation Rules & Aggregation
**Example:** Hydrate Automation Rules
```typescript
// init — account-level binding, no resource argument
const batchGetAutomationRules = yield* AWS.SecurityHub.BatchGetAutomationRules();

// runtime
const { Rules } = yield* batchGetAutomationRules({
  AutomationRulesArns: [rule.ruleArn],
});
```

@binding

## BatchGetSecurityControls

Runtime binding for `securityhub:BatchGetSecurityControls`.

Returns detailed definitions for a batch of security controls by id or ARN.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.BatchGetSecurityControlsHttp)`.
### Standards & Controls
**Example:** Hydrate Control Details
```typescript
// init — account-level binding, no resource argument
const batchGetSecurityControls = yield* AWS.SecurityHub.BatchGetSecurityControls();

// runtime
const { SecurityControls } = yield* batchGetSecurityControls({
  SecurityControlIds: ["IAM.1", "S3.1"],
});
```

@binding

## BatchGetStandardsControlAssociations

Runtime binding for `securityhub:BatchGetStandardsControlAssociations`.

Returns the enablement status of a batch of controls within specific standards.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.BatchGetStandardsControlAssociationsHttp)`.
### Standards & Controls
**Example:** Read Control Associations
```typescript
// init — account-level binding, no resource argument
const batchGetStandardsControlAssociations = yield* AWS.SecurityHub.BatchGetStandardsControlAssociations();

// runtime
const { StandardsControlAssociationDetails } =
  yield* batchGetStandardsControlAssociations({
    StandardsControlAssociationIds: [
      { SecurityControlId: "IAM.1", StandardsArn: standardsArn },
    ],
  });
```

@binding

## BatchImportFindings

Runtime binding for `securityhub:BatchImportFindings`.

Imports findings in AWS Security Finding Format (ASFF) from a custom integration into Security Hub.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.BatchImportFindingsHttp)`.
### Working with Findings
**Example:** Import a Custom Finding
```typescript
// init — account-level binding, no resource argument
const batchImportFindings = yield* AWS.SecurityHub.BatchImportFindings();

// runtime
const { SuccessCount } = yield* batchImportFindings({
  Findings: [myAsffFinding],
});
```

@binding

## BatchUpdateFindings

Runtime binding for `securityhub:BatchUpdateFindings`.

Updates workflow status, severity, notes, and other customer-editable fields on one or more findings.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.BatchUpdateFindingsHttp)`.
### Working with Findings
**Example:** Resolve a Finding
```typescript
// init — account-level binding, no resource argument
const batchUpdateFindings = yield* AWS.SecurityHub.BatchUpdateFindings();

// runtime
yield* batchUpdateFindings({
  FindingIdentifiers: [{ Id: findingId, ProductArn: productArn }],
  Workflow: { Status: "RESOLVED" },
});
```

@binding

## BatchUpdateStandardsControlAssociations

Runtime binding for `securityhub:BatchUpdateStandardsControlAssociations`.

Enables or disables a batch of controls within specific standards.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.BatchUpdateStandardsControlAssociationsHttp)`.
### Standards & Controls
**Example:** Disable a Control in One Standard
```typescript
// init — account-level binding, no resource argument
const batchUpdateStandardsControlAssociations = yield* AWS.SecurityHub.BatchUpdateStandardsControlAssociations();

// runtime
yield* batchUpdateStandardsControlAssociations({
  StandardsControlAssociationUpdates: [{
    SecurityControlId: "IAM.1",
    StandardsArn: standardsArn,
    AssociationStatus: "DISABLED",
    UpdatedReason: "handled by SSO",
  }],
});
```

@binding

## CreateMembers

Runtime binding for `securityhub:CreateMembers`.

Creates member associations between this administrator account and the specified accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.CreateMembersHttp)`.
### Members & Organization
**Example:** Add Member Accounts
```typescript
// init — account-level binding, no resource argument
const createMembers = yield* AWS.SecurityHub.CreateMembers();

// runtime
const { UnprocessedAccounts } = yield* createMembers({
  AccountDetails: [{ AccountId: "111122223333" }],
});
```

@binding

## DeclineInvitations

Runtime binding for `securityhub:DeclineInvitations`.

Declines Security Hub membership invitations from the specified accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DeclineInvitationsHttp)`.
### Members & Organization
**Example:** Decline Invitations
```typescript
// init — account-level binding, no resource argument
const declineInvitations = yield* AWS.SecurityHub.DeclineInvitations();

// runtime
yield* declineInvitations({ AccountIds: ["111122223333"] });
```

@binding

## DeleteInvitations

Runtime binding for `securityhub:DeleteInvitations`.

Deletes Security Hub membership invitations from the specified accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DeleteInvitationsHttp)`.
### Members & Organization
**Example:** Delete Invitations
```typescript
// init — account-level binding, no resource argument
const deleteInvitations = yield* AWS.SecurityHub.DeleteInvitations();

// runtime
yield* deleteInvitations({ AccountIds: ["111122223333"] });
```

@binding

## DeleteMembers

Runtime binding for `securityhub:DeleteMembers`.

Deletes the member associations for the specified accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DeleteMembersHttp)`.
### Members & Organization
**Example:** Delete Members
```typescript
// init — account-level binding, no resource argument
const deleteMembers = yield* AWS.SecurityHub.DeleteMembers();

// runtime
yield* deleteMembers({ AccountIds: ["111122223333"] });
```

@binding

## DescribeActionTargets

Runtime binding for `securityhub:DescribeActionTargets`.

Lists the custom action targets defined in the account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DescribeActionTargetsHttp)`.
### Custom Actions, Automation Rules & Aggregation
**Example:** List Custom Actions
```typescript
// init — account-level binding, no resource argument
const describeActionTargets = yield* AWS.SecurityHub.DescribeActionTargets();

// runtime
const { ActionTargets } = yield* describeActionTargets();
```

@binding

## DescribeOrganizationConfiguration

Runtime binding for `securityhub:DescribeOrganizationConfiguration`.

Returns how Security Hub is configured across the organization (auto-enable, central configuration).
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DescribeOrganizationConfigurationHttp)`.
### Members & Organization
**Example:** Read the Organization Configuration
```typescript
// init — account-level binding, no resource argument
const describeOrganizationConfiguration = yield* AWS.SecurityHub.DescribeOrganizationConfiguration();

// runtime
const { AutoEnable } = yield* describeOrganizationConfiguration();
```

@binding

## DescribeProducts

Runtime binding for `securityhub:DescribeProducts`.

Lists the product integrations available in Security Hub (AWS services and partner products).
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DescribeProductsHttp)`.
### Product Integrations
**Example:** List Available Products
```typescript
// init — account-level binding, no resource argument
const describeProducts = yield* AWS.SecurityHub.DescribeProducts();

// runtime
const { Products } = yield* describeProducts({ MaxResults: 10 });
```

@binding

## DescribeStandards

Runtime binding for `securityhub:DescribeStandards`.

Lists the security standards available in Security Hub.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DescribeStandardsHttp)`.
### Standards & Controls
**Example:** List Available Standards
```typescript
// init — account-level binding, no resource argument
const describeStandards = yield* AWS.SecurityHub.DescribeStandards();

// runtime
const { Standards } = yield* describeStandards();
```

@binding

## DescribeStandardsControls

Runtime binding for `securityhub:DescribeStandardsControls`.

Lists the controls of an enabled standard with their current status.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DescribeStandardsControlsHttp)`.
### Standards & Controls
**Example:** List a Standard's Controls
```typescript
// init — account-level binding, no resource argument
const describeStandardsControls = yield* AWS.SecurityHub.DescribeStandardsControls();

// runtime
const { Controls } = yield* describeStandardsControls({
  StandardsSubscriptionArn: subscriptionArn,
});
```

@binding

## DisableImportFindingsForProduct

Runtime binding for `securityhub:DisableImportFindingsForProduct`.

Disables a product integration so its findings no longer flow into Security Hub.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DisableImportFindingsForProductHttp)`.
### Product Integrations
**Example:** Disable a Product Integration
```typescript
// init — account-level binding, no resource argument
const disableImportFindingsForProduct = yield* AWS.SecurityHub.DisableImportFindingsForProduct();

// runtime
yield* disableImportFindingsForProduct({
  ProductSubscriptionArn: subscriptionArn,
});
```

@binding

## DisableOrganizationAdminAccount

Runtime binding for `securityhub:DisableOrganizationAdminAccount`.

Removes an organization account's delegated Security Hub administrator status.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DisableOrganizationAdminAccountHttp)`.
### Members & Organization
**Example:** Remove the Delegated Administrator
```typescript
// init — account-level binding, no resource argument
const disableOrganizationAdminAccount = yield* AWS.SecurityHub.DisableOrganizationAdminAccount();

// runtime
yield* disableOrganizationAdminAccount({ AdminAccountId: "111122223333" });
```

@binding

## DisassociateFromAdministratorAccount

Runtime binding for `securityhub:DisassociateFromAdministratorAccount`.

Disassociates this member account from its Security Hub administrator account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DisassociateFromAdministratorAccountHttp)`.
### Members & Organization
**Example:** Leave the Administrator
```typescript
// init — account-level binding, no resource argument
const disassociateFromAdministratorAccount = yield* AWS.SecurityHub.DisassociateFromAdministratorAccount();

// runtime
yield* disassociateFromAdministratorAccount();
```

@binding

## DisassociateMembers

Runtime binding for `securityhub:DisassociateMembers`.

Disassociates the specified member accounts from this administrator account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.DisassociateMembersHttp)`.
### Members & Organization
**Example:** Disassociate Members
```typescript
// init — account-level binding, no resource argument
const disassociateMembers = yield* AWS.SecurityHub.DisassociateMembers();

// runtime
yield* disassociateMembers({ AccountIds: ["111122223333"] });
```

@binding

## EnableImportFindingsForProduct

Runtime binding for `securityhub:EnableImportFindingsForProduct`.

Enables a product integration so its findings flow into Security Hub.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.EnableImportFindingsForProductHttp)`.
### Product Integrations
**Example:** Enable a Product Integration
```typescript
// init — account-level binding, no resource argument
const enableImportFindingsForProduct = yield* AWS.SecurityHub.EnableImportFindingsForProduct();

// runtime
const { ProductSubscriptionArn } = yield* enableImportFindingsForProduct({
  ProductArn: productArn,
});
```

@binding

## EnableOrganizationAdminAccount

Runtime binding for `securityhub:EnableOrganizationAdminAccount`.

Designates an organization account as the delegated Security Hub administrator.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.EnableOrganizationAdminAccountHttp)`.
### Members & Organization
**Example:** Delegate an Organization Administrator
```typescript
// init — account-level binding, no resource argument
const enableOrganizationAdminAccount = yield* AWS.SecurityHub.EnableOrganizationAdminAccount();

// runtime
yield* enableOrganizationAdminAccount({ AdminAccountId: "111122223333" });
```

@binding

## GetAdministratorAccount

Runtime binding for `securityhub:GetAdministratorAccount`.

Returns the details of the Security Hub administrator account for this member account, if any.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.GetAdministratorAccountHttp)`.
### Members & Organization
**Example:** Read the Administrator Account
```typescript
// init — account-level binding, no resource argument
const getAdministratorAccount = yield* AWS.SecurityHub.GetAdministratorAccount();

// runtime
const { Administrator } = yield* getAdministratorAccount();
```

@binding

## GetEnabledStandards

Runtime binding for `securityhub:GetEnabledStandards`.

Lists the standards subscriptions currently enabled in the account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.GetEnabledStandardsHttp)`.
### Standards & Controls
**Example:** List Enabled Standards
```typescript
// init — account-level binding, no resource argument
const getEnabledStandards = yield* AWS.SecurityHub.GetEnabledStandards();

// runtime
const { StandardsSubscriptions } = yield* getEnabledStandards();
```

@binding

## GetFindingHistory

Runtime binding for `securityhub:GetFindingHistory`.

Returns the history of a finding for up to 90 days — every update Security Hub or a provider applied to it.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.GetFindingHistoryHttp)`.
### Working with Findings
**Example:** Audit a Finding's History
```typescript
// init — account-level binding, no resource argument
const getFindingHistory = yield* AWS.SecurityHub.GetFindingHistory();

// runtime
const { Records } = yield* getFindingHistory({
  FindingIdentifier: { Id: findingId, ProductArn: productArn },
});
```

@binding

## GetFindings

Runtime binding for `securityhub:GetFindings`.

Returns findings that match the specified filter criteria. With cross-Region aggregation enabled, the home Region returns matching findings from all linked Regions.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.GetFindingsHttp)`.
### Working with Findings
**Example:** Query High-Severity Findings
```typescript
// init — account-level binding, no resource argument
const getFindings = yield* AWS.SecurityHub.GetFindings();

// runtime
const { Findings } = yield* getFindings({
  Filters: { SeverityLabel: [{ Value: "HIGH", Comparison: "EQUALS" }] },
  MaxResults: 25,
});
```

@binding

## GetInsightResults

Runtime binding for `securityhub:GetInsightResults`.

Returns the aggregated results of a Security Hub insight, grouped by the insight's group-by attribute.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.GetInsightResultsHttp)`.
### Working with Insights
**Example:** Read Insight Results
```typescript
// init — account-level binding, no resource argument
const getInsightResults = yield* AWS.SecurityHub.GetInsightResults();

// runtime
const { InsightResults } = yield* getInsightResults({
  InsightArn: insight.insightArn,
});
```

@binding

## GetInsights

Runtime binding for `securityhub:GetInsights`.

Lists and describes Security Hub insights (saved, grouped finding queries).
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.GetInsightsHttp)`.
### Working with Insights
**Example:** List Custom Insights
```typescript
// init — account-level binding, no resource argument
const getInsights = yield* AWS.SecurityHub.GetInsights();

// runtime
const { Insights } = yield* getInsights();
```

@binding

## GetInvitationsCount

Runtime binding for `securityhub:GetInvitationsCount`.

Returns the count of membership invitations received by this account (excluding accepted ones).
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.GetInvitationsCountHttp)`.
### Members & Organization
**Example:** Count Pending Invitations
```typescript
// init — account-level binding, no resource argument
const getInvitationsCount = yield* AWS.SecurityHub.GetInvitationsCount();

// runtime
const { InvitationsCount } = yield* getInvitationsCount();
```

@binding

## GetMembers

Runtime binding for `securityhub:GetMembers`.

Returns the member details for the specified accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.GetMembersHttp)`.
### Members & Organization
**Example:** Get Member Details
```typescript
// init — account-level binding, no resource argument
const getMembers = yield* AWS.SecurityHub.GetMembers();

// runtime
const { Members } = yield* getMembers({ AccountIds: ["111122223333"] });
```

@binding

## GetSecurityControlDefinition

Runtime binding for `securityhub:GetSecurityControlDefinition`.

Returns the definition (title, description, parameters, severity) of a single security control.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.GetSecurityControlDefinitionHttp)`.
### Standards & Controls
**Example:** Read a Control Definition
```typescript
// init — account-level binding, no resource argument
const getSecurityControlDefinition = yield* AWS.SecurityHub.GetSecurityControlDefinition();

// runtime
const { SecurityControlDefinition } = yield* getSecurityControlDefinition({
  SecurityControlId: "IAM.1",
});
```

@binding

## InviteMembers

Runtime binding for `securityhub:InviteMembers`.

Invites the specified accounts to associate with this account as Security Hub members.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.InviteMembersHttp)`.
### Members & Organization
**Example:** Invite Members
```typescript
// init — account-level binding, no resource argument
const inviteMembers = yield* AWS.SecurityHub.InviteMembers();

// runtime
yield* inviteMembers({ AccountIds: ["111122223333"] });
```

@binding

## ListAutomationRules

Runtime binding for `securityhub:ListAutomationRules`.

Lists the automation rules defined in the account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.ListAutomationRulesHttp)`.
### Custom Actions, Automation Rules & Aggregation
**Example:** List Automation Rules
```typescript
// init — account-level binding, no resource argument
const listAutomationRules = yield* AWS.SecurityHub.ListAutomationRules();

// runtime
const { AutomationRulesMetadata } = yield* listAutomationRules();
```

@binding

## ListEnabledProductsForImport

Runtime binding for `securityhub:ListEnabledProductsForImport`.

Lists the product integrations currently enabled to import findings into Security Hub.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.ListEnabledProductsForImportHttp)`.
### Product Integrations
**Example:** List Enabled Products
```typescript
// init — account-level binding, no resource argument
const listEnabledProductsForImport = yield* AWS.SecurityHub.ListEnabledProductsForImport();

// runtime
const { ProductSubscriptions } = yield* listEnabledProductsForImport();
```

@binding

## ListFindingAggregators

Runtime binding for `securityhub:ListFindingAggregators`.

Lists the cross-Region finding aggregators configured in the account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.ListFindingAggregatorsHttp)`.
### Custom Actions, Automation Rules & Aggregation
**Example:** List Finding Aggregators
```typescript
// init — account-level binding, no resource argument
const listFindingAggregators = yield* AWS.SecurityHub.ListFindingAggregators();

// runtime
const { FindingAggregators } = yield* listFindingAggregators();
```

@binding

## ListInvitations

Runtime binding for `securityhub:ListInvitations`.

Lists the Security Hub membership invitations received by this account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.ListInvitationsHttp)`.
### Members & Organization
**Example:** List Invitations
```typescript
// init — account-level binding, no resource argument
const listInvitations = yield* AWS.SecurityHub.ListInvitations();

// runtime
const { Invitations } = yield* listInvitations();
```

@binding

## ListMembers

Runtime binding for `securityhub:ListMembers`.

Lists the member accounts associated with this administrator account.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.ListMembersHttp)`.
### Members & Organization
**Example:** List Members
```typescript
// init — account-level binding, no resource argument
const listMembers = yield* AWS.SecurityHub.ListMembers();

// runtime
const { Members } = yield* listMembers();
```

@binding

## ListOrganizationAdminAccounts

Runtime binding for `securityhub:ListOrganizationAdminAccounts`.

Lists the organization's delegated Security Hub administrator accounts.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.ListOrganizationAdminAccountsHttp)`.
### Members & Organization
**Example:** List Delegated Administrators
```typescript
// init — account-level binding, no resource argument
const listOrganizationAdminAccounts = yield* AWS.SecurityHub.ListOrganizationAdminAccounts();

// runtime
const { AdminAccounts } = yield* listOrganizationAdminAccounts();
```

@binding

## ListSecurityControlDefinitions

Runtime binding for `securityhub:ListSecurityControlDefinitions`.

Lists all security control definitions, optionally restricted to one standard.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.ListSecurityControlDefinitionsHttp)`.
### Standards & Controls
**Example:** List Control Definitions
```typescript
// init — account-level binding, no resource argument
const listSecurityControlDefinitions = yield* AWS.SecurityHub.ListSecurityControlDefinitions();

// runtime
const { SecurityControlDefinitions } = yield* listSecurityControlDefinitions();
```

@binding

## ListStandardsControlAssociations

Runtime binding for `securityhub:ListStandardsControlAssociations`.

Lists, for one security control, every standard it belongs to and its enablement status there.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.ListStandardsControlAssociationsHttp)`.
### Standards & Controls
**Example:** List a Control's Associations
```typescript
// init — account-level binding, no resource argument
const listStandardsControlAssociations = yield* AWS.SecurityHub.ListStandardsControlAssociations();

// runtime
const { StandardsControlAssociationSummaries } =
  yield* listStandardsControlAssociations({ SecurityControlId: "IAM.1" });
```

@binding

## UpdateOrganizationConfiguration

Runtime binding for `securityhub:UpdateOrganizationConfiguration`.

Updates how Security Hub is configured across the organization (auto-enable, central configuration).
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.UpdateOrganizationConfigurationHttp)`.
### Members & Organization
**Example:** Auto-Enable New Accounts
```typescript
// init — account-level binding, no resource argument
const updateOrganizationConfiguration = yield* AWS.SecurityHub.UpdateOrganizationConfiguration();

// runtime
yield* updateOrganizationConfiguration({ AutoEnable: true });
```

@binding

## UpdateSecurityControl

Runtime binding for `securityhub:UpdateSecurityControl`.

Updates the customizable parameters of a security control.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.UpdateSecurityControlHttp)`.
### Standards & Controls
**Example:** Tune a Control Parameter
```typescript
// init — account-level binding, no resource argument
const updateSecurityControl = yield* AWS.SecurityHub.UpdateSecurityControl();

// runtime
yield* updateSecurityControl({
  SecurityControlId: "ACM.1",
  Parameters: { daysToExpiration: { ValueType: "CUSTOM", Value: { Integer: 15 } } },
});
```

@binding

## UpdateStandardsControl

Runtime binding for `securityhub:UpdateStandardsControl`.

Enables or disables an individual control within an enabled standard.
Account-level operation — invoked with the caller's request as-is.
Provide the implementation with
`Effect.provide(AWS.SecurityHub.UpdateStandardsControlHttp)`.
### Standards & Controls
**Example:** Disable a Control
```typescript
// init — account-level binding, no resource argument
const updateStandardsControl = yield* AWS.SecurityHub.UpdateStandardsControl();

// runtime
yield* updateStandardsControl({
  StandardsControlArn: controlArn,
  ControlStatus: "DISABLED",
  DisabledReason: "not applicable to this workload",
});
```

@binding
