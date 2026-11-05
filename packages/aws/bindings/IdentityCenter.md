<!-- Docs for the generated AWS.IdentityCenter bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateGroupMembership

Runtime binding for the `CreateGroupMembership` operation (IAM action
`identitystore:CreateGroupMembership`), scoped to one {@link Instance}.

Adds a user to a group in the bound instance's identity store, returning the new `MembershipId`. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.CreateGroupMembershipHttp)`.
### Managing Group Memberships
**Example:** Add a User to a Group
```typescript
// init — bind the operation to the Identity Center instance
const createGroupMembership = yield* AWS.IdentityCenter.CreateGroupMembership(instance);

// runtime
const { MembershipId } = yield* createGroupMembership({
  GroupId: groupId,
  MemberId: { UserId: userId },
});
```

@binding

## CreateUser

Runtime binding for the `CreateUser` operation (IAM action
`identitystore:CreateUser`), scoped to one {@link Instance}.

Creates a user in the bound instance's identity store — e.g. a just-in-time provisioning Lambda mirroring users from an external HR system. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.CreateUserHttp)`.
### Managing Users
**Example:** Provision a User
```typescript
// init — bind the operation to the Identity Center instance
const createUser = yield* AWS.IdentityCenter.CreateUser(instance);

// runtime
const { UserId } = yield* createUser({
  UserName: "jdoe",
  DisplayName: "Jane Doe",
  Name: { GivenName: "Jane", FamilyName: "Doe" },
  Emails: [{ Value: "jdoe@example.com", Primary: true }],
});
```

@binding

## DeleteGroupMembership

Runtime binding for the `DeleteGroupMembership` operation (IAM action
`identitystore:DeleteGroupMembership`), scoped to one {@link Instance}.

Removes a group membership from the bound instance's identity store by `MembershipId`. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.DeleteGroupMembershipHttp)`.
### Managing Group Memberships
**Example:** Remove a User From a Group
```typescript
// init — bind the operation to the Identity Center instance
const deleteGroupMembership = yield* AWS.IdentityCenter.DeleteGroupMembership(instance);

// runtime
yield* deleteGroupMembership({ MembershipId: membershipId });
```

@binding

## DeleteUser

Runtime binding for the `DeleteUser` operation (IAM action
`identitystore:DeleteUser`), scoped to one {@link Instance}.

Deletes a user from the bound instance's identity store — the deprovisioning half of a user-sync Lambda. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.DeleteUserHttp)`.
### Managing Users
**Example:** Deprovision a User
```typescript
// init — bind the operation to the Identity Center instance
const deleteUser = yield* AWS.IdentityCenter.DeleteUser(instance);

// runtime
yield* deleteUser({ UserId: userId });
```

@binding

## DescribeGroupMembership

Runtime binding for the `DescribeGroupMembership` operation (IAM action
`identitystore:DescribeGroupMembership`), scoped to one {@link Instance}.

Reads a group membership (group id + member id) from the bound instance's identity store by `MembershipId`. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.DescribeGroupMembershipHttp)`.
### Querying Group Memberships
**Example:** Read a Membership
```typescript
// init — bind the operation to the Identity Center instance
const describeGroupMembership = yield* AWS.IdentityCenter.DescribeGroupMembership(instance);

// runtime
const membership = yield* describeGroupMembership({
  MembershipId: membershipId,
});
console.log(membership.GroupId, membership.MemberId);
```

@binding

## DescribePermissionSet

Runtime binding for the `DescribePermissionSet` operation (IAM action
`sso:DescribePermissionSet`), scoped to one {@link Instance}.

Reads a permission set's details (name, description, session duration, relay state) from the bound Identity Center instance. The instance's
`InstanceArn` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.DescribePermissionSetHttp)`.
### Reading Permission Sets
**Example:** Read a Permission Set
```typescript
// init — bind the operation to the Identity Center instance
const describePermissionSet = yield* AWS.IdentityCenter.DescribePermissionSet(instance);

// runtime
const { PermissionSet } = yield* describePermissionSet({
  PermissionSetArn: permissionSetArn,
});
console.log(PermissionSet?.Name, PermissionSet?.SessionDuration);
```

@binding

## DescribeUser

Runtime binding for the `DescribeUser` operation (IAM action
`identitystore:DescribeUser`), scoped to one {@link Instance}.

Reads a user's metadata and attributes (user name, display name, emails) from the bound instance's identity store by `UserId`. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.DescribeUserHttp)`.
### Looking Up Users
**Example:** Read a User's Profile
```typescript
// init — bind the operation to the Identity Center instance
const describeUser = yield* AWS.IdentityCenter.DescribeUser(instance);

// runtime
const user = yield* describeUser({ UserId: userId });
console.log(user.UserName, user.DisplayName);
```

@binding

## GetGroupId

Runtime binding for the `GetGroupId` operation (IAM action
`identitystore:GetGroupId`), scoped to one {@link Instance}.

Resolves a group's `GroupId` from a unique attribute (e.g. the display name) in the bound instance's identity store. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.GetGroupIdHttp)`.
### Looking Up Groups
**Example:** Resolve a GroupId From a Display Name
```typescript
// init — bind the operation to the Identity Center instance
const getGroupId = yield* AWS.IdentityCenter.GetGroupId(instance);

// runtime
const { GroupId } = yield* getGroupId({
  AlternateIdentifier: {
    UniqueAttribute: {
      AttributePath: "displayName",
      AttributeValue: "platform-engineers",
    },
  },
});
```

@binding

## GetGroupMembershipId

Runtime binding for the `GetGroupMembershipId` operation (IAM action
`identitystore:GetGroupMembershipId`), scoped to one {@link Instance}.

Resolves the `MembershipId` linking a user to a group in the bound instance's identity store. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.GetGroupMembershipIdHttp)`.
### Querying Group Memberships
**Example:** Resolve a MembershipId
```typescript
// init — bind the operation to the Identity Center instance
const getGroupMembershipId = yield* AWS.IdentityCenter.GetGroupMembershipId(instance);

// runtime
const { MembershipId } = yield* getGroupMembershipId({
  GroupId: groupId,
  MemberId: { UserId: userId },
});
```

@binding

## GetUserId

Runtime binding for the `GetUserId` operation (IAM action
`identitystore:GetUserId`), scoped to one {@link Instance}.

Resolves a user's `UserId` from a unique attribute (e.g. the user name) — the canonical login-to-id lookup for apps federated through Identity Center. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.GetUserIdHttp)`.
### Looking Up Users
**Example:** Resolve a UserId From a User Name
```typescript
// init — bind the operation to the Identity Center instance
const getUserId = yield* AWS.IdentityCenter.GetUserId(instance);

// runtime
const { UserId } = yield* getUserId({
  AlternateIdentifier: {
    UniqueAttribute: {
      AttributePath: "userName",
      AttributeValue: "jdoe",
    },
  },
});
```

@binding

## IsMemberInGroups

Runtime binding for the `IsMemberInGroups` operation (IAM action
`identitystore:IsMemberInGroups`), scoped to one {@link Instance}.

Checks whether a user belongs to any of up to 100 groups in one call — the fast authorization primitive for group-gated routes. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.IsMemberInGroupsHttp)`.
### Querying Group Memberships
**Example:** Gate a Route on Group Membership
```typescript
// init — bind the operation to the Identity Center instance
const isMemberInGroups = yield* AWS.IdentityCenter.IsMemberInGroups(instance);

// runtime
const { Results } = yield* isMemberInGroups({
  MemberId: { UserId: userId },
  GroupIds: [adminGroupId],
});
const isAdmin = Results?.[0]?.MembershipExists === true;
```

@binding

## ListAccountAssignments

Runtime binding for the `ListAccountAssignments` operation (IAM action
`sso:ListAccountAssignments`), scoped to one {@link Instance}.

Lists who (users/groups) holds a permission set in an AWS account — the core query of an access-review Lambda. The instance's
`InstanceArn` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.ListAccountAssignmentsHttp)`.
### Auditing Access
**Example:** List a Permission Set's Assignees
```typescript
// init — bind the operation to the Identity Center instance
const listAccountAssignments = yield* AWS.IdentityCenter.ListAccountAssignments(instance);

// runtime
const { AccountAssignments } = yield* listAccountAssignments({
  AccountId: accountId,
  PermissionSetArn: permissionSetArn,
});
```

@binding

## ListAccountAssignmentsForPrincipal

Runtime binding for the `ListAccountAssignmentsForPrincipal` operation (IAM action
`sso:ListAccountAssignmentsForPrincipal`), scoped to one {@link Instance}.

Lists every account assignment a user or group holds across the organization — "what can this principal access?" for access portals. Only valid on organization instances, called from the management account. The instance's
`InstanceArn` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.ListAccountAssignmentsForPrincipalHttp)`.
### Auditing Access
**Example:** List a Principal's Assignments
```typescript
// init — bind the operation to the Identity Center instance
const listAccountAssignmentsForPrincipal = yield* AWS.IdentityCenter.ListAccountAssignmentsForPrincipal(instance);

// runtime
const { AccountAssignments } = yield* listAccountAssignmentsForPrincipal({
  PrincipalId: groupId,
  PrincipalType: "GROUP",
});
```

@binding

## ListAccountsForProvisionedPermissionSet

Runtime binding for the `ListAccountsForProvisionedPermissionSet` operation (IAM action
`sso:ListAccountsForProvisionedPermissionSet`), scoped to one {@link Instance}.

Lists the AWS accounts where a permission set is provisioned, one page per call (`NextToken` paginates). The instance's
`InstanceArn` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.ListAccountsForProvisionedPermissionSetHttp)`.
### Auditing Access
**Example:** List a Permission Set's Accounts
```typescript
// init — bind the operation to the Identity Center instance
const listAccountsForProvisionedPermissionSet = yield* AWS.IdentityCenter.ListAccountsForProvisionedPermissionSet(instance);

// runtime
const { AccountIds } = yield* listAccountsForProvisionedPermissionSet({
  PermissionSetArn: permissionSetArn,
});
```

@binding

## ListGroupMemberships

Runtime binding for the `ListGroupMemberships` operation (IAM action
`identitystore:ListGroupMemberships`), scoped to one {@link Instance}.

Lists the members of a group in the bound instance's identity store, one page per call (`NextToken` paginates). The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.ListGroupMembershipsHttp)`.
### Querying Group Memberships
**Example:** Enumerate a Group's Members
```typescript
// init — bind the operation to the Identity Center instance
const listGroupMemberships = yield* AWS.IdentityCenter.ListGroupMemberships(instance);

// runtime
const { GroupMemberships } = yield* listGroupMemberships({
  GroupId: groupId,
});
```

@binding

## ListGroupMembershipsForMember

Runtime binding for the `ListGroupMembershipsForMember` operation (IAM action
`identitystore:ListGroupMembershipsForMember`), scoped to one {@link Instance}.

Lists every group a user belongs to in the bound instance's identity store, one page per call (`NextToken` paginates). The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.ListGroupMembershipsForMemberHttp)`.
### Querying Group Memberships
**Example:** Enumerate a User's Groups
```typescript
// init — bind the operation to the Identity Center instance
const listGroupMembershipsForMember = yield* AWS.IdentityCenter.ListGroupMembershipsForMember(instance);

// runtime
const { GroupMemberships } = yield* listGroupMembershipsForMember({
  MemberId: { UserId: userId },
});
```

@binding

## ListGroups

Runtime binding for the `ListGroups` operation (IAM action
`identitystore:ListGroups`), scoped to one {@link Instance}.

Lists the groups in the bound instance's identity store, one page per call (`NextToken` paginates); pass `Filters` to narrow by attribute. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.ListGroupsHttp)`.
### Looking Up Groups
**Example:** Enumerate Groups
```typescript
// init — bind the operation to the Identity Center instance
const listGroups = yield* AWS.IdentityCenter.ListGroups(instance);

// runtime
const { Groups } = yield* listGroups({ MaxResults: 50 });
console.log(Groups?.map((group) => group.DisplayName));
```

@binding

## ListPermissionSets

Runtime binding for the `ListPermissionSets` operation (IAM action
`sso:ListPermissionSets`), scoped to one {@link Instance}.

Lists the permission set ARNs in the bound Identity Center instance, one page per call (`NextToken` paginates). The instance's
`InstanceArn` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.ListPermissionSetsHttp)`.
### Reading Permission Sets
**Example:** Enumerate Permission Sets
```typescript
// init — bind the operation to the Identity Center instance
const listPermissionSets = yield* AWS.IdentityCenter.ListPermissionSets(instance);

// runtime
const { PermissionSets } = yield* listPermissionSets({ MaxResults: 100 });
```

@binding

## ListUsers

Runtime binding for the `ListUsers` operation (IAM action
`identitystore:ListUsers`), scoped to one {@link Instance}.

Lists the users in the bound instance's identity store, one page per call (`NextToken` paginates); pass `Filters` to narrow by attribute. The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.ListUsersHttp)`.
### Looking Up Users
**Example:** Enumerate Users
```typescript
// init — bind the operation to the Identity Center instance
const listUsers = yield* AWS.IdentityCenter.ListUsers(instance);

// runtime
const { Users, NextToken } = yield* listUsers({ MaxResults: 50 });
console.log(Users?.map((user) => user.UserName));
```

@binding

## UpdateUser

Runtime binding for the `UpdateUser` operation (IAM action
`identitystore:UpdateUser`), scoped to one {@link Instance}.

Applies attribute patch operations to a user in the bound instance's identity store (display name, emails, addresses, ...). The instance's
`IdentityStoreId` is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IdentityCenter.UpdateUserHttp)`.
### Managing Users
**Example:** Update a User's Display Name
```typescript
// init — bind the operation to the Identity Center instance
const updateUser = yield* AWS.IdentityCenter.UpdateUser(instance);

// runtime
yield* updateUser({
  UserId: userId,
  Operations: [
    { AttributePath: "displayName", AttributeValue: "Jane A. Doe" },
  ],
});
```

@binding
