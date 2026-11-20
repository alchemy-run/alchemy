<!-- Docs for the generated AWS.RAM bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AcceptResourceShareInvitation

Runtime binding for `ram:AcceptResourceShareInvitation`.

Accepts an invitation to a resource share from another account, granting this account access to the shared resources.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.AcceptResourceShareInvitationHttp)`.
### Invitations
**Example:** Accept an Invitation
```typescript
// init — account-level binding, no resource argument
const acceptResourceShareInvitation = yield* AWS.RAM.AcceptResourceShareInvitation();

// runtime
const { resourceShareInvitation } =
  yield* acceptResourceShareInvitation({
    resourceShareInvitationArn: invitationArn,
  });
```

@binding

## GetPermission

Runtime binding for `ram:GetPermission`.

Retrieves the contents of a managed permission in JSON format, including its policy template.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.GetPermissionHttp)`.
### Managed Permissions
**Example:** Read a Managed Permission
```typescript
// init — account-level binding, no resource argument
const getPermission = yield* AWS.RAM.GetPermission();

// runtime
const { permission } = yield* getPermission({
  permissionArn: customerManagedPermission.permissionArn,
});
```

@binding

## GetResourcePolicies

Runtime binding for `ram:GetResourcePolicies`.

Retrieves the RAM-generated resource policies attached to resources that you own and have shared.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.GetResourcePoliciesHttp)`.
### Discovering Shares & Shared Resources
**Example:** Read the Policy of a Shared Resource
```typescript
// init — account-level binding, no resource argument
const getResourcePolicies = yield* AWS.RAM.GetResourcePolicies();

// runtime
const { policies } = yield* getResourcePolicies({
  resourceArns: [subnetArn],
});
```

@binding

## GetResourceShareAssociations

Runtime binding for `ram:GetResourceShareAssociations`.

Retrieves the principal and resource associations of your resource shares — who has access, and to what.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.GetResourceShareAssociationsHttp)`.
### Discovering Shares & Shared Resources
**Example:** List the Principals Associated with Your Shares
```typescript
// init — account-level binding, no resource argument
const getResourceShareAssociations = yield* AWS.RAM.GetResourceShareAssociations();

// runtime
const { resourceShareAssociations } =
  yield* getResourceShareAssociations({ associationType: "PRINCIPAL" });
```

@binding

## GetResourceShareInvitations

Runtime binding for `ram:GetResourceShareInvitations`.

Retrieves the invitations to resource shares that other accounts extended to you.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.GetResourceShareInvitationsHttp)`.
### Invitations
**Example:** List Your Pending Invitations
```typescript
// init — account-level binding, no resource argument
const getResourceShareInvitations = yield* AWS.RAM.GetResourceShareInvitations();

// runtime
const { resourceShareInvitations } =
  yield* getResourceShareInvitations();
```

@binding

## GetResourceShares

Runtime binding for `ram:GetResourceShares`.

Retrieves details about the resource shares that you own (`resourceOwner: "SELF"`) or that are shared with you (`resourceOwner: "OTHER-ACCOUNTS"`).
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.GetResourceSharesHttp)`.
### Discovering Shares & Shared Resources
**Example:** List the Resource Shares You Own
```typescript
// init — account-level binding, no resource argument
const getResourceShares = yield* AWS.RAM.GetResourceShares();

// runtime
const { resourceShares } = yield* getResourceShares({
  resourceOwner: "SELF",
});
```

@binding

## ListPendingInvitationResources

Runtime binding for `ram:ListPendingInvitationResources`.

Lists the resources inside a resource share whose invitation to you is still pending.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.ListPendingInvitationResourcesHttp)`.
### Invitations
**Example:** Inspect an Invitation Before Accepting
```typescript
// init — account-level binding, no resource argument
const listPendingInvitationResources = yield* AWS.RAM.ListPendingInvitationResources();

// runtime
const { resources } = yield* listPendingInvitationResources({
  resourceShareInvitationArn: invitationArn,
});
```

@binding

## ListPermissionAssociations

Runtime binding for `ram:ListPermissionAssociations`.

Lists information about managed permissions and their associations to resource shares.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.ListPermissionAssociationsHttp)`.
### Managed Permissions
**Example:** List Permission Associations
```typescript
// init — account-level binding, no resource argument
const listPermissionAssociations = yield* AWS.RAM.ListPermissionAssociations();

// runtime
const { permissions } = yield* listPermissionAssociations({
  defaultVersion: true,
});
```

@binding

## ListPermissionVersions

Runtime binding for `ram:ListPermissionVersions`.

Lists the available versions of the specified RAM permission.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.ListPermissionVersionsHttp)`.
### Managed Permissions
**Example:** List the Versions of a Permission
```typescript
// init — account-level binding, no resource argument
const listPermissionVersions = yield* AWS.RAM.ListPermissionVersions();

// runtime
const { permissions } = yield* listPermissionVersions({
  permissionArn: permission.permissionArn,
});
```

@binding

## ListPermissions

Runtime binding for `ram:ListPermissions`.

Lists the AWS managed and customer managed RAM permissions available for the supported resource types.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.ListPermissionsHttp)`.
### Managed Permissions
**Example:** List the Customer Managed Permissions
```typescript
// init — account-level binding, no resource argument
const listPermissions = yield* AWS.RAM.ListPermissions();

// runtime
const { permissions } = yield* listPermissions({
  permissionType: "CUSTOMER_MANAGED",
});
```

@binding

## ListPrincipals

Runtime binding for `ram:ListPrincipals`.

Lists the principals that you are sharing resources with or that are sharing resources with you.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.ListPrincipalsHttp)`.
### Discovering Shares & Shared Resources
**Example:** List the Principals You Share With
```typescript
// init — account-level binding, no resource argument
const listPrincipals = yield* AWS.RAM.ListPrincipals();

// runtime
const { principals } = yield* listPrincipals({ resourceOwner: "SELF" });
```

@binding

## ListResourceSharePermissions

Runtime binding for `ram:ListResourceSharePermissions`.

Lists the RAM permissions that are associated with a resource share.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.ListResourceSharePermissionsHttp)`.
### Managed Permissions
**Example:** List the Permissions on a Share
```typescript
// init — account-level binding, no resource argument
const listResourceSharePermissions = yield* AWS.RAM.ListResourceSharePermissions();

// runtime
const { permissions } = yield* listResourceSharePermissions({
  resourceShareArn: share.resourceShareArn,
});
```

@binding

## ListResourceTypes

Runtime binding for `ram:ListResourceTypes`.

Lists the resource types that can be shared through RAM.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.ListResourceTypesHttp)`.
### Discovering Shares & Shared Resources
**Example:** List the Shareable Resource Types
```typescript
// init — account-level binding, no resource argument
const listResourceTypes = yield* AWS.RAM.ListResourceTypes();

// runtime
const { resourceTypes } = yield* listResourceTypes();
```

@binding

## ListResources

Runtime binding for `ram:ListResources`.

Lists the resources that you added to resource shares or that are shared with you.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.ListResourcesHttp)`.
### Discovering Shares & Shared Resources
**Example:** List the Resources Shared with You
```typescript
// init — account-level binding, no resource argument
const listResources = yield* AWS.RAM.ListResources();

// runtime
const { resources } = yield* listResources({
  resourceOwner: "OTHER-ACCOUNTS",
});
```

@binding

## ListSourceAssociations

Runtime binding for `ram:ListSourceAssociations`.

Lists the source associations of your resource shares — the sources that service-managed shares draw resources from.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.ListSourceAssociationsHttp)`.
### Discovering Shares & Shared Resources
**Example:** List Source Associations
```typescript
// init — account-level binding, no resource argument
const listSourceAssociations = yield* AWS.RAM.ListSourceAssociations();

// runtime
const { sourceAssociations } = yield* listSourceAssociations();
```

@binding

## RejectResourceShareInvitation

Runtime binding for `ram:RejectResourceShareInvitation`.

Rejects an invitation to a resource share from another account.
Account-level operation — the target shares, invitations, and permissions
are chosen per request at runtime, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.RAM.RejectResourceShareInvitationHttp)`.
### Invitations
**Example:** Reject an Invitation
```typescript
// init — account-level binding, no resource argument
const rejectResourceShareInvitation = yield* AWS.RAM.RejectResourceShareInvitation();

// runtime
const { resourceShareInvitation } =
  yield* rejectResourceShareInvitation({
    resourceShareInvitationArn: invitationArn,
  });
```

@binding
