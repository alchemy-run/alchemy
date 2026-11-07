<!-- Docs for the generated AWS.Organizations bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AcceptHandshake

Runtime binding for `organizations:AcceptHandshake`.

Accepts a pending handshake — e.g. an invitation to join an organization, called from the invited member account.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.AcceptHandshakeHttp)`.
### Handshakes & Invitations
**Example:** Accept an Invitation
```typescript
// init — account-level binding, no resource argument
const acceptHandshake = yield* AWS.Organizations.AcceptHandshake();

// runtime
const { Handshake } = yield* acceptHandshake({ HandshakeId: handshakeId });
```

@binding

## CancelHandshake

Runtime binding for `organizations:CancelHandshake`.

Cancels a pending handshake from the originator side — e.g. withdrawing an invitation before the recipient responds.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.CancelHandshakeHttp)`.
### Handshakes & Invitations
**Example:** Withdraw an Invitation
```typescript
// init — account-level binding, no resource argument
const cancelHandshake = yield* AWS.Organizations.CancelHandshake();

// runtime
const { Handshake } = yield* cancelHandshake({ HandshakeId: handshakeId });
```

@binding

## DeclineHandshake

Runtime binding for `organizations:DeclineHandshake`.

Declines a pending handshake, ending the invitation from the recipient side; the originator can no longer act on it.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.DeclineHandshakeHttp)`.
### Handshakes & Invitations
**Example:** Decline an Invitation
```typescript
// init — account-level binding, no resource argument
const declineHandshake = yield* AWS.Organizations.DeclineHandshake();

// runtime
const { Handshake } = yield* declineHandshake({ HandshakeId: handshakeId });
```

@binding

## DescribeCreateAccountStatus

Runtime binding for `organizations:DescribeCreateAccountStatus`.

Retrieves the current status of an asynchronous account-creation request — the polling half of an account-vending workflow.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.DescribeCreateAccountStatusHttp)`.
### Account Vending
**Example:** Poll an Account-Creation Request
```typescript
// init — account-level binding, no resource argument
const describeCreateAccountStatus = yield* AWS.Organizations.DescribeCreateAccountStatus();

// runtime
const { CreateAccountStatus } = yield* describeCreateAccountStatus({
  CreateAccountRequestId: requestId,
});
```

@binding

## DescribeEffectivePolicy

Runtime binding for `organizations:DescribeEffectivePolicy`.

Returns the contents of the effective policy of the specified type for an account — the aggregation of inherited plus directly attached management policies (tag, backup, AI-services opt-out, …).
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.DescribeEffectivePolicyHttp)`.
### Policies & Effective Policy
**Example:** Read an Account's Effective Tag Policy
```typescript
// init — account-level binding, no resource argument
const describeEffectivePolicy = yield* AWS.Organizations.DescribeEffectivePolicy();

// runtime
const { EffectivePolicy } = yield* describeEffectivePolicy({
  PolicyType: "TAG_POLICY",
  TargetId: accountId,
});
```

@binding

## DescribeHandshake

Runtime binding for `organizations:DescribeHandshake`.

Returns the details and current state of a handshake — accepted, declined, or canceled handshakes stay readable for 30 days.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.DescribeHandshakeHttp)`.
### Handshakes & Invitations
**Example:** Read a Handshake
```typescript
// init — account-level binding, no resource argument
const describeHandshake = yield* AWS.Organizations.DescribeHandshake();

// runtime
const { Handshake } = yield* describeHandshake({ HandshakeId: handshakeId });
```

@binding

## DescribeOrganization

Runtime binding for `organizations:DescribeOrganization`.

Retrieves information about the organization that the calling account belongs to — its id, ARN, feature set, and management account. Available from any account in the organization.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.DescribeOrganizationHttp)`.
### Reading the Organization Tree
**Example:** Read the Organization
```typescript
// init — account-level binding, no resource argument
const describeOrganization = yield* AWS.Organizations.DescribeOrganization();

// runtime
const { Organization } = yield* describeOrganization();
console.log(Organization?.Id, Organization?.MasterAccountId);
```

@binding

## InviteAccountToOrganization

Runtime binding for `organizations:InviteAccountToOrganization`.

Sends an invitation (handshake) to another account to join the organization as a member account.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.InviteAccountToOrganizationHttp)`.
### Handshakes & Invitations
**Example:** Invite an Account
```typescript
// init — account-level binding, no resource argument
const inviteAccountToOrganization = yield* AWS.Organizations.InviteAccountToOrganization();

// runtime
const { Handshake } = yield* inviteAccountToOrganization({
  Target: { Id: "111122223333", Type: "ACCOUNT" },
});
```

@binding

## ListAWSServiceAccessForOrganization

Runtime binding for `organizations:ListAWSServiceAccessForOrganization`.

Lists the Amazon Web Services services that are enabled for trusted access with the organization.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListAWSServiceAccessForOrganizationHttp)`.
### Delegated Administration & Trusted Access
**Example:** List Trusted-Access Services
```typescript
// init — account-level binding, no resource argument
const listAWSServiceAccessForOrganization = yield* AWS.Organizations.ListAWSServiceAccessForOrganization();

// runtime
const { EnabledServicePrincipals } =
  yield* listAWSServiceAccessForOrganization();
```

@binding

## ListAccounts

Runtime binding for `organizations:ListAccounts`.

Lists all accounts in the organization — the backbone of cross-account automation that iterates every member account.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListAccountsHttp)`.
### Reading the Organization Tree
**Example:** Iterate Every Account
```typescript
// init — account-level binding, no resource argument
const listAccounts = yield* AWS.Organizations.ListAccounts();

// runtime
const { Accounts } = yield* listAccounts();
```

@binding

## ListAccountsForParent

Runtime binding for `organizations:ListAccountsForParent`.

Lists the accounts directly contained by the specified root or organizational unit (not accounts in child OUs).
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListAccountsForParentHttp)`.
### Reading the Organization Tree
**Example:** List Accounts Under an OU
```typescript
// init — account-level binding, no resource argument
const listAccountsForParent = yield* AWS.Organizations.ListAccountsForParent();

// runtime
const { Accounts } = yield* listAccountsForParent({ ParentId: ouId });
```

@binding

## ListAccountsWithInvalidEffectivePolicy

Runtime binding for `organizations:ListAccountsWithInvalidEffectivePolicy`.

Lists the accounts whose effective policy of the specified type is invalid — e.g. exceeds the size limit after policy inheritance.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListAccountsWithInvalidEffectivePolicyHttp)`.
### Policies & Effective Policy
**Example:** Audit Invalid Effective Policies
```typescript
// init — account-level binding, no resource argument
const listAccountsWithInvalidEffectivePolicy = yield* AWS.Organizations.ListAccountsWithInvalidEffectivePolicy();

// runtime
const { Accounts } = yield* listAccountsWithInvalidEffectivePolicy({
  PolicyType: "TAG_POLICY",
});
```

@binding

## ListChildren

Runtime binding for `organizations:ListChildren`.

Lists the child accounts or organizational units directly under the specified parent root or OU — one level of the organization tree at a time.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListChildrenHttp)`.
### Reading the Organization Tree
**Example:** Walk One Tree Level
```typescript
// init — account-level binding, no resource argument
const listChildren = yield* AWS.Organizations.ListChildren();

// runtime
const { Children } = yield* listChildren({
  ParentId: rootId,
  ChildType: "ORGANIZATIONAL_UNIT",
});
```

@binding

## ListCreateAccountStatus

Runtime binding for `organizations:ListCreateAccountStatus`.

Lists the account-creation requests that match the specified states — auditing in-flight and completed account vending.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListCreateAccountStatusHttp)`.
### Account Vending
**Example:** List In-Flight Account Creations
```typescript
// init — account-level binding, no resource argument
const listCreateAccountStatus = yield* AWS.Organizations.ListCreateAccountStatus();

// runtime
const { CreateAccountStatuses } = yield* listCreateAccountStatus({
  States: ["IN_PROGRESS"],
});
```

@binding

## ListDelegatedAdministrators

Runtime binding for `organizations:ListDelegatedAdministrators`.

Lists the accounts that are designated as delegated administrators in the organization, optionally filtered by service principal.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListDelegatedAdministratorsHttp)`.
### Delegated Administration & Trusted Access
**Example:** List Delegated Administrators
```typescript
// init — account-level binding, no resource argument
const listDelegatedAdministrators = yield* AWS.Organizations.ListDelegatedAdministrators();

// runtime
const { DelegatedAdministrators } = yield* listDelegatedAdministrators();
```

@binding

## ListDelegatedServicesForAccount

Runtime binding for `organizations:ListDelegatedServicesForAccount`.

Lists the Amazon Web Services services for which the specified account is a delegated administrator.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListDelegatedServicesForAccountHttp)`.
### Delegated Administration & Trusted Access
**Example:** List an Account's Delegated Services
```typescript
// init — account-level binding, no resource argument
const listDelegatedServicesForAccount = yield* AWS.Organizations.ListDelegatedServicesForAccount();

// runtime
const { DelegatedServices } = yield* listDelegatedServicesForAccount({
  AccountId: accountId,
});
```

@binding

## ListEffectivePolicyValidationErrors

Runtime binding for `organizations:ListEffectivePolicyValidationErrors`.

Lists the validation errors in an account's effective policy of the specified type — the reasons the aggregated policy is invalid.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListEffectivePolicyValidationErrorsHttp)`.
### Policies & Effective Policy
**Example:** Read Effective-Policy Validation Errors
```typescript
// init — account-level binding, no resource argument
const listEffectivePolicyValidationErrors = yield* AWS.Organizations.ListEffectivePolicyValidationErrors();

// runtime
const { EffectivePolicyValidationErrors } =
  yield* listEffectivePolicyValidationErrors({
    AccountId: accountId,
    PolicyType: "TAG_POLICY",
  });
```

@binding

## ListHandshakesForAccount

Runtime binding for `organizations:ListHandshakesForAccount`.

Lists the handshakes that are associated with the calling account — pending and recently concluded invitations.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListHandshakesForAccountHttp)`.
### Handshakes & Invitations
**Example:** List the Account's Handshakes
```typescript
// init — account-level binding, no resource argument
const listHandshakesForAccount = yield* AWS.Organizations.ListHandshakesForAccount();

// runtime
const { Handshakes } = yield* listHandshakesForAccount();
```

@binding

## ListHandshakesForOrganization

Runtime binding for `organizations:ListHandshakesForOrganization`.

Lists the handshakes sent by the organization's management account — outstanding and recently concluded invitations.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListHandshakesForOrganizationHttp)`.
### Handshakes & Invitations
**Example:** List the Organization's Handshakes
```typescript
// init — account-level binding, no resource argument
const listHandshakesForOrganization = yield* AWS.Organizations.ListHandshakesForOrganization();

// runtime
const { Handshakes } = yield* listHandshakesForOrganization();
```

@binding

## ListOrganizationalUnitsForParent

Runtime binding for `organizations:ListOrganizationalUnitsForParent`.

Lists the organizational units directly contained by the specified root or parent OU.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListOrganizationalUnitsForParentHttp)`.
### Reading the Organization Tree
**Example:** List Child OUs
```typescript
// init — account-level binding, no resource argument
const listOrganizationalUnitsForParent = yield* AWS.Organizations.ListOrganizationalUnitsForParent();

// runtime
const { OrganizationalUnits } = yield* listOrganizationalUnitsForParent({
  ParentId: rootId,
});
```

@binding

## ListParents

Runtime binding for `organizations:ListParents`.

Lists the direct parent (root or OU) of the specified child account or OU — walking the organization tree upward.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListParentsHttp)`.
### Reading the Organization Tree
**Example:** Find an Account's Parent
```typescript
// init — account-level binding, no resource argument
const listParents = yield* AWS.Organizations.ListParents();

// runtime
const { Parents } = yield* listParents({ ChildId: accountId });
```

@binding

## ListPolicies

Runtime binding for `organizations:ListPolicies`.

Lists all policies of the specified type (service control, tag, backup, AI-services opt-out, …) in the organization.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListPoliciesHttp)`.
### Policies & Effective Policy
**Example:** List Service Control Policies
```typescript
// init — account-level binding, no resource argument
const listPolicies = yield* AWS.Organizations.ListPolicies();

// runtime
const { Policies } = yield* listPolicies({ Filter: "SERVICE_CONTROL_POLICY" });
```

@binding

## ListPoliciesForTarget

Runtime binding for `organizations:ListPoliciesForTarget`.

Lists the policies of the specified type that are directly attached to the specified target root, OU, or account.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListPoliciesForTargetHttp)`.
### Policies & Effective Policy
**Example:** List Policies Attached to a Target
```typescript
// init — account-level binding, no resource argument
const listPoliciesForTarget = yield* AWS.Organizations.ListPoliciesForTarget();

// runtime
const { Policies } = yield* listPoliciesForTarget({
  TargetId: accountId,
  Filter: "SERVICE_CONTROL_POLICY",
});
```

@binding

## ListRoots

Runtime binding for `organizations:ListRoots`.

Lists the roots of the organization, including the policy types enabled on each root. The root id is the starting point for walking the organization tree.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListRootsHttp)`.
### Reading the Organization Tree
**Example:** Find the Root Id
```typescript
// init — account-level binding, no resource argument
const listRoots = yield* AWS.Organizations.ListRoots();

// runtime
const { Roots } = yield* listRoots();
const rootId = Roots?.[0]?.Id;
```

@binding

## ListTagsForResource

Runtime binding for `organizations:ListTagsForResource`.

Lists the tags attached to the specified Organizations resource — an account, root, organizational unit, or policy.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListTagsForResourceHttp)`.
### Tags
**Example:** Read an Account's Organization Tags
```typescript
// init — account-level binding, no resource argument
const listTagsForResource = yield* AWS.Organizations.ListTagsForResource();

// runtime
const { Tags } = yield* listTagsForResource({ ResourceId: accountId });
```

@binding

## ListTargetsForPolicy

Runtime binding for `organizations:ListTargetsForPolicy`.

Lists all roots, organizational units, and accounts that the specified policy is attached to.
Account-level operation — Organizations is a management-account-scoped
global service, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Organizations.ListTargetsForPolicyHttp)`.
### Policies & Effective Policy
**Example:** List a Policy's Targets
```typescript
// init — account-level binding, no resource argument
const listTargetsForPolicy = yield* AWS.Organizations.ListTargetsForPolicy();

// runtime
const { Targets } = yield* listTargetsForPolicy({ PolicyId: policyId });
```

@binding
