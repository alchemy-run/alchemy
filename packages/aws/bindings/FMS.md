<!-- Docs for the generated AWS.FMS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AssociateThirdPartyFirewall

Runtime binding for `fms:AssociateThirdPartyFirewall`.

Sets the Firewall Manager policy administrator as a tenant administrator of a third-party firewall service (Palo Alto Networks Cloud NGFW or
Fortigate Cloud Native Firewall). Requires an active AWS Marketplace subscription to the vendor. Provide the implementation with
`Effect.provide(AWS.FMS.AssociateThirdPartyFirewallHttp)`.
### Third-Party Firewalls
**Example:** Onboard a Third-Party Firewall Vendor
```typescript
// init — account-level binding takes no resource
const associateThirdPartyFirewall = yield* AWS.FMS.AssociateThirdPartyFirewall();

// runtime
const result = yield* associateThirdPartyFirewall({
  ThirdPartyFirewall: "PALO_ALTO_NETWORKS_CLOUD_NGFW",
});
console.log(result.ThirdPartyFirewallStatus);
```

@binding

## AssociateThirdPartyFirewall.Request

Request for {@link AssociateThirdPartyFirewall}.

## BatchAssociateResource

Runtime binding for `fms:BatchAssociateResource`.

Associates resources with the specified Firewall Manager resource set, reporting per-item failures. Provide the
implementation with `Effect.provide(AWS.FMS.BatchAssociateResourceHttp)`.
### Resource Sets
**Example:** Associate Resources into a Resource Set
```typescript
// init — account-level binding takes no resource
const batchAssociateResource = yield* AWS.FMS.BatchAssociateResource();

// runtime
const result = yield* batchAssociateResource({
  ResourceSetIdentifier: resourceSetId,
  Items: [firewallArn],
});
console.log(result.FailedItems.length);
```

@binding

## BatchAssociateResource.Request

Request for {@link BatchAssociateResource}.

## BatchDisassociateResource

Runtime binding for `fms:BatchDisassociateResource`.

Disassociates resources from the specified Firewall Manager resource set, reporting per-item failures. Provide the
implementation with `Effect.provide(AWS.FMS.BatchDisassociateResourceHttp)`.
### Resource Sets
**Example:** Disassociate Resources from a Resource Set
```typescript
// init — account-level binding takes no resource
const batchDisassociateResource = yield* AWS.FMS.BatchDisassociateResource();

// runtime
const result = yield* batchDisassociateResource({
  ResourceSetIdentifier: resourceSetId,
  Items: [firewallArn],
});
console.log(result.FailedItems.length);
```

@binding

## BatchDisassociateResource.Request

Request for {@link BatchDisassociateResource}.

## DeleteAppsList

Runtime binding for `fms:DeleteAppsList`.

Permanently deletes the specified Firewall Manager applications list. Provide the
implementation with `Effect.provide(AWS.FMS.DeleteAppsListHttp)`.
### Applications Lists
**Example:** Delete an Applications List
```typescript
// init — account-level binding takes no resource
const deleteAppsList = yield* AWS.FMS.DeleteAppsList();

// runtime
yield* deleteAppsList({ ListId: listId });
```

@binding

## DeleteAppsList.Request

Request for {@link DeleteAppsList}.

## DeleteNotificationChannel

Runtime binding for `fms:DeleteNotificationChannel`.

Deletes the Firewall Manager association with the IAM role and SNS topic used to record SNS logs. Provide the
implementation with `Effect.provide(AWS.FMS.DeleteNotificationChannelHttp)`.
### Notification Channel
**Example:** Delete the Notification Channel
```typescript
// init — account-level binding takes no resource
const deleteNotificationChannel = yield* AWS.FMS.DeleteNotificationChannel();

// runtime
yield* deleteNotificationChannel();
```

@binding

## DeleteNotificationChannel.Request

Request for {@link DeleteNotificationChannel}.

## DeletePolicy

Runtime binding for `fms:DeletePolicy`.

Permanently deletes the specified Firewall Manager policy, optionally cleaning up the resources it created in member accounts. Provide the
implementation with `Effect.provide(AWS.FMS.DeletePolicyHttp)`.
### Managing Policies
**Example:** Delete a Policy
```typescript
// init — account-level binding takes no resource
const deletePolicy = yield* AWS.FMS.DeletePolicy();

// runtime
yield* deletePolicy({ PolicyId: policyId, DeleteAllPolicyResources: true });
```

@binding

## DeletePolicy.Request

Request for {@link DeletePolicy}.

## DeleteProtocolsList

Runtime binding for `fms:DeleteProtocolsList`.

Permanently deletes the specified Firewall Manager protocols list. Provide the
implementation with `Effect.provide(AWS.FMS.DeleteProtocolsListHttp)`.
### Protocols Lists
**Example:** Delete a Protocols List
```typescript
// init — account-level binding takes no resource
const deleteProtocolsList = yield* AWS.FMS.DeleteProtocolsList();

// runtime
yield* deleteProtocolsList({ ListId: listId });
```

@binding

## DeleteProtocolsList.Request

Request for {@link DeleteProtocolsList}.

## DeleteResourceSet

Runtime binding for `fms:DeleteResourceSet`.

Permanently deletes the specified Firewall Manager resource set. Provide the
implementation with `Effect.provide(AWS.FMS.DeleteResourceSetHttp)`.
### Resource Sets
**Example:** Delete a Resource Set
```typescript
// init — account-level binding takes no resource
const deleteResourceSet = yield* AWS.FMS.DeleteResourceSet();

// runtime
yield* deleteResourceSet({ Identifier: resourceSetId });
```

@binding

## DeleteResourceSet.Request

Request for {@link DeleteResourceSet}.

## DisassociateThirdPartyFirewall

Runtime binding for `fms:DisassociateThirdPartyFirewall`.

Disassociates a Firewall Manager policy administrator from a third-party firewall tenant. The third-party vendor deletes all of the firewalls
associated with the account. Provide the implementation with `Effect.provide(AWS.FMS.DisassociateThirdPartyFirewallHttp)`.
### Third-Party Firewalls
**Example:** Offboard a Third-Party Firewall Vendor
```typescript
// init — account-level binding takes no resource
const disassociateThirdPartyFirewall = yield* AWS.FMS.DisassociateThirdPartyFirewall();

// runtime
const result = yield* disassociateThirdPartyFirewall({
  ThirdPartyFirewall: "PALO_ALTO_NETWORKS_CLOUD_NGFW",
});
console.log(result.ThirdPartyFirewallStatus);
```

@binding

## DisassociateThirdPartyFirewall.Request

Request for {@link DisassociateThirdPartyFirewall}.

## GetAdminScope

Runtime binding for `fms:GetAdminScope`.

Returns information about the specified account's administrative scope — the resources a Firewall Manager administrator can manage. Provide the
implementation with `Effect.provide(AWS.FMS.GetAdminScopeHttp)`.
### Administrator Management
**Example:** Read an Administrator's Scope
```typescript
// init — account-level binding takes no resource
const getAdminScope = yield* AWS.FMS.GetAdminScope();

// runtime
const result = yield* getAdminScope({ AdminAccount: accountId });
console.log(result.Status, result.AdminScope?.PolicyTypeScope);
```

@binding

## GetAdminScope.Request

Request for {@link GetAdminScope}.

## GetAppsList

Runtime binding for `fms:GetAppsList`.

Returns the specified Firewall Manager applications list. Provide the
implementation with `Effect.provide(AWS.FMS.GetAppsListHttp)`.
### Applications Lists
**Example:** Read an Applications List
```typescript
// init — account-level binding takes no resource
const getAppsList = yield* AWS.FMS.GetAppsList();

// runtime
const result = yield* getAppsList({ ListId: listId });
console.log(result.AppsList?.AppsList?.length);
```

@binding

## GetAppsList.Request

Request for {@link GetAppsList}.

## GetComplianceDetail

Runtime binding for `fms:GetComplianceDetail`.

Returns detailed compliance information about the specified member account — the resources that are in and out of compliance with the specified policy. Provide the
implementation with `Effect.provide(AWS.FMS.GetComplianceDetailHttp)`.
### Compliance and Protection Status
**Example:** Read a Member Account's Compliance Detail
```typescript
// init — account-level binding takes no resource
const getComplianceDetail = yield* AWS.FMS.GetComplianceDetail();

// runtime
const result = yield* getComplianceDetail({
  PolicyId: policyId,
  MemberAccount: accountId,
});
console.log(result.PolicyComplianceDetail?.Violators?.length);
```

@binding

## GetComplianceDetail.Request

Request for {@link GetComplianceDetail}.

## GetNotificationChannel

Runtime binding for `fms:GetNotificationChannel`.

Returns the SNS topic that is used to record Firewall Manager SNS logs. Provide the
implementation with `Effect.provide(AWS.FMS.GetNotificationChannelHttp)`.
### Notification Channel
**Example:** Read the Notification Channel
```typescript
// init — account-level binding takes no resource
const getNotificationChannel = yield* AWS.FMS.GetNotificationChannel();

// runtime
const result = yield* getNotificationChannel();
console.log(result.SnsTopicArn);
```

@binding

## GetNotificationChannel.Request

Request for {@link GetNotificationChannel}.

## GetPolicy

Runtime binding for `fms:GetPolicy`.

Returns the specified Firewall Manager policy. Provide the
implementation with `Effect.provide(AWS.FMS.GetPolicyHttp)`.
### Reading Policies
**Example:** Read a Policy
```typescript
// init — account-level binding takes no resource
const getPolicy = yield* AWS.FMS.GetPolicy();

// runtime
const result = yield* getPolicy({ PolicyId: policyId });
console.log(result.Policy?.PolicyName);
```

@binding

## GetPolicy.Request

Request for {@link GetPolicy}.

## GetProtectionStatus

Runtime binding for `fms:GetProtectionStatus`.

Returns policy-level attack summary information for Shield Advanced policies — DDoS attacks detected during the specified time period. Provide the
implementation with `Effect.provide(AWS.FMS.GetProtectionStatusHttp)`.
### Compliance and Protection Status
**Example:** Read a Shield Policy's Protection Status
```typescript
// init — account-level binding takes no resource
const getProtectionStatus = yield* AWS.FMS.GetProtectionStatus();

// runtime
const result = yield* getProtectionStatus({ PolicyId: policyId });
console.log(result.ServiceType, result.Data);
```

@binding

## GetProtectionStatus.Request

Request for {@link GetProtectionStatus}.

## GetProtocolsList

Runtime binding for `fms:GetProtocolsList`.

Returns the specified Firewall Manager protocols list. Provide the
implementation with `Effect.provide(AWS.FMS.GetProtocolsListHttp)`.
### Protocols Lists
**Example:** Read a Protocols List
```typescript
// init — account-level binding takes no resource
const getProtocolsList = yield* AWS.FMS.GetProtocolsList();

// runtime
const result = yield* getProtocolsList({ ListId: listId });
console.log(result.ProtocolsList?.ProtocolsList);
```

@binding

## GetProtocolsList.Request

Request for {@link GetProtocolsList}.

## GetResourceSet

Runtime binding for `fms:GetResourceSet`.

Returns the specified Firewall Manager resource set. Provide the
implementation with `Effect.provide(AWS.FMS.GetResourceSetHttp)`.
### Resource Sets
**Example:** Read a Resource Set
```typescript
// init — account-level binding takes no resource
const getResourceSet = yield* AWS.FMS.GetResourceSet();

// runtime
const result = yield* getResourceSet({ Identifier: resourceSetId });
console.log(result.ResourceSet.Name);
```

@binding

## GetResourceSet.Request

Request for {@link GetResourceSet}.

## GetViolationDetails

Runtime binding for `fms:GetViolationDetails`.

Returns violation details for the specified resource covered by a Firewall Manager network ACL, security group, Network Firewall, DNS Firewall, or third-party firewall policy. Provide the
implementation with `Effect.provide(AWS.FMS.GetViolationDetailsHttp)`.
### Compliance and Protection Status
**Example:** Read a Resource's Violation Details
```typescript
// init — account-level binding takes no resource
const getViolationDetails = yield* AWS.FMS.GetViolationDetails();

// runtime
const result = yield* getViolationDetails({
  PolicyId: policyId,
  MemberAccount: accountId,
  ResourceId: instanceId,
  ResourceType: "AWS::EC2::Instance",
});
console.log(result.ViolationDetail?.ResourceViolations.length);
```

@binding

## GetViolationDetails.Request

Request for {@link GetViolationDetails}.

## ListAdminAccountsForOrganization

Runtime binding for `fms:ListAdminAccountsForOrganization`.

Returns the Firewall Manager administrator accounts in the organization — only usable by the organization's management account. Provide the
implementation with `Effect.provide(AWS.FMS.ListAdminAccountsForOrganizationHttp)`.
### Administrator Management
**Example:** List the Organization's Administrators
```typescript
// init — account-level binding takes no resource
const listAdminAccountsForOrganization = yield* AWS.FMS.ListAdminAccountsForOrganization();

// runtime
const result = yield* listAdminAccountsForOrganization();
console.log(result.AdminAccounts?.length);
```

@binding

## ListAdminAccountsForOrganization.Request

Request for {@link ListAdminAccountsForOrganization}.

## ListAdminsManagingAccount

Runtime binding for `fms:ListAdminsManagingAccount`.

Returns the administrators who have the calling account within their administrative scope — usable by any member account to see who manages it. Provide the
implementation with `Effect.provide(AWS.FMS.ListAdminsManagingAccountHttp)`.
### Administrator Management
**Example:** List the Administrators Managing This Account
```typescript
// init — account-level binding takes no resource
const listAdminsManagingAccount = yield* AWS.FMS.ListAdminsManagingAccount();

// runtime
const result = yield* listAdminsManagingAccount();
console.log(result.AdminAccounts?.length);
```

@binding

## ListAdminsManagingAccount.Request

Request for {@link ListAdminsManagingAccount}.

## ListAppsLists

Runtime binding for `fms:ListAppsLists`.

Returns an array of `AppsListDataSummary` objects for the applications lists in the administrator's account. Provide the
implementation with `Effect.provide(AWS.FMS.ListAppsListsHttp)`.
### Applications Lists
**Example:** List Applications Lists
```typescript
// init — account-level binding takes no resource
const listAppsLists = yield* AWS.FMS.ListAppsLists();

// runtime
const result = yield* listAppsLists({ MaxResults: 25 });
console.log(result.AppsLists?.length);
```

@binding

## ListAppsLists.Request

Request for {@link ListAppsLists}.

## ListComplianceStatus

Runtime binding for `fms:ListComplianceStatus`.

Returns an array of `PolicyComplianceStatus` objects — use it to get a summary of which member accounts are protected by the specified policy. Provide the
implementation with `Effect.provide(AWS.FMS.ListComplianceStatusHttp)`.
### Compliance and Protection Status
**Example:** List a Policy's Compliance Status
```typescript
// init — account-level binding takes no resource
const listComplianceStatus = yield* AWS.FMS.ListComplianceStatus();

// runtime
const result = yield* listComplianceStatus({ PolicyId: policyId });
console.log(result.PolicyComplianceStatusList?.length);
```

@binding

## ListComplianceStatus.Request

Request for {@link ListComplianceStatus}.

## ListDiscoveredResources

Runtime binding for `fms:ListDiscoveredResources`.

Returns an array of resources in the organization's accounts that are available to be associated with a resource set. Provide the
implementation with `Effect.provide(AWS.FMS.ListDiscoveredResourcesHttp)`.
### Resource Sets
**Example:** Discover Associable Resources
```typescript
// init — account-level binding takes no resource
const listDiscoveredResources = yield* AWS.FMS.ListDiscoveredResources();

// runtime
const result = yield* listDiscoveredResources({
  MemberAccountIds: [accountId],
  ResourceType: "AWS::EC2::Instance",
});
console.log(result.Items?.length);
```

@binding

## ListDiscoveredResources.Request

Request for {@link ListDiscoveredResources}.

## ListMemberAccounts

Runtime binding for `fms:ListMemberAccounts`.

Returns the member account ids in the administrator's Amazon Web Services organization — only usable by the organization's management account or a delegated administrator. Provide the
implementation with `Effect.provide(AWS.FMS.ListMemberAccountsHttp)`.
### Compliance and Protection Status
**Example:** List Member Accounts
```typescript
// init — account-level binding takes no resource
const listMemberAccounts = yield* AWS.FMS.ListMemberAccounts();

// runtime
const result = yield* listMemberAccounts();
console.log(result.MemberAccounts?.length);
```

@binding

## ListMemberAccounts.Request

Request for {@link ListMemberAccounts}.

## ListPolicies

Runtime binding for `fms:ListPolicies`.

Returns the `PolicySummary` list for the Firewall Manager policies in the administrator's account. Provide the
implementation with `Effect.provide(AWS.FMS.ListPoliciesHttp)`.
### Reading Policies
**Example:** List Policies
```typescript
// init — account-level binding takes no resource
const listPolicies = yield* AWS.FMS.ListPolicies();

// runtime
const result = yield* listPolicies();
console.log(result.PolicyList?.length);
```

@binding

## ListPolicies.Request

Request for {@link ListPolicies}.

## ListProtocolsLists

Runtime binding for `fms:ListProtocolsLists`.

Returns an array of `ProtocolsListDataSummary` objects for the protocols lists in the administrator's account. Provide the
implementation with `Effect.provide(AWS.FMS.ListProtocolsListsHttp)`.
### Protocols Lists
**Example:** List Protocols Lists
```typescript
// init — account-level binding takes no resource
const listProtocolsLists = yield* AWS.FMS.ListProtocolsLists();

// runtime
const result = yield* listProtocolsLists({ MaxResults: 25 });
console.log(result.ProtocolsLists?.length);
```

@binding

## ListProtocolsLists.Request

Request for {@link ListProtocolsLists}.

## ListResourceSetResources

Runtime binding for `fms:ListResourceSetResources`.

Returns an array of the resources associated with the specified Firewall Manager resource set. Provide the
implementation with `Effect.provide(AWS.FMS.ListResourceSetResourcesHttp)`.
### Resource Sets
**Example:** List a Resource Set's Members
```typescript
// init — account-level binding takes no resource
const listResourceSetResources = yield* AWS.FMS.ListResourceSetResources();

// runtime
const result = yield* listResourceSetResources({ Identifier: resourceSetId });
console.log(result.Items.length);
```

@binding

## ListResourceSetResources.Request

Request for {@link ListResourceSetResources}.

## ListResourceSets

Runtime binding for `fms:ListResourceSets`.

Returns an array of `ResourceSetSummary` objects for the resource sets in the administrator's account. Provide the
implementation with `Effect.provide(AWS.FMS.ListResourceSetsHttp)`.
### Resource Sets
**Example:** List Resource Sets
```typescript
// init — account-level binding takes no resource
const listResourceSets = yield* AWS.FMS.ListResourceSets();

// runtime
const result = yield* listResourceSets();
console.log(result.ResourceSets?.length);
```

@binding

## ListResourceSets.Request

Request for {@link ListResourceSets}.

## PutAppsList

Runtime binding for `fms:PutAppsList`.

Creates or updates a Firewall Manager applications list. Provide the
implementation with `Effect.provide(AWS.FMS.PutAppsListHttp)`.
### Applications Lists
**Example:** Create an Applications List
```typescript
// init — account-level binding takes no resource
const putAppsList = yield* AWS.FMS.PutAppsList();

// runtime
const result = yield* putAppsList({
  AppsList: {
    ListName: "allowed-apps",
    AppsList: [{ AppName: "web", Protocol: "TCP", Port: 443 }],
  },
});
console.log(result.AppsList?.ListId);
```

@binding

## PutAppsList.Request

Request for {@link PutAppsList}.

## PutNotificationChannel

Runtime binding for `fms:PutNotificationChannel`.

Designates the SNS topic and IAM role that Firewall Manager uses to record SNS logs — the channel through which Firewall Manager notifications flow. Provide the
implementation with `Effect.provide(AWS.FMS.PutNotificationChannelHttp)`.
### Notification Channel
**Example:** Set the Notification Channel
```typescript
// init — account-level binding takes no resource
const putNotificationChannel = yield* AWS.FMS.PutNotificationChannel();

// runtime
yield* putNotificationChannel({
  SnsTopicArn: topicArn,
  SnsRoleName: roleArn,
});
```

@binding

## PutNotificationChannel.Request

Request for {@link PutNotificationChannel}.

## PutPolicy

Runtime binding for `fms:PutPolicy`.

Creates or updates a Firewall Manager policy — a WAF, Shield Advanced, security group, Network Firewall, DNS Firewall, or network ACL policy applied across the organization's accounts. Provide the
implementation with `Effect.provide(AWS.FMS.PutPolicyHttp)`.
### Managing Policies
**Example:** Create a Policy
```typescript
// init — account-level binding takes no resource
const putPolicy = yield* AWS.FMS.PutPolicy();

// runtime
const result = yield* putPolicy({
  Policy: {
    PolicyName: "org-waf-baseline",
    SecurityServicePolicyData: { Type: "WAFV2", ManagedServiceData: "..." },
    ResourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    ExcludeResourceTags: false,
    RemediationEnabled: true,
  },
});
console.log(result.Policy?.PolicyId);
```

@binding

## PutPolicy.Request

Request for {@link PutPolicy}.

## PutProtocolsList

Runtime binding for `fms:PutProtocolsList`.

Creates or updates a Firewall Manager protocols list. Provide the
implementation with `Effect.provide(AWS.FMS.PutProtocolsListHttp)`.
### Protocols Lists
**Example:** Create a Protocols List
```typescript
// init — account-level binding takes no resource
const putProtocolsList = yield* AWS.FMS.PutProtocolsList();

// runtime
const result = yield* putProtocolsList({
  ProtocolsList: { ListName: "allowed-protocols", ProtocolsList: ["TCP", "UDP"] },
});
console.log(result.ProtocolsList?.ListId);
```

@binding

## PutProtocolsList.Request

Request for {@link PutProtocolsList}.

## PutResourceSet

Runtime binding for `fms:PutResourceSet`.

Creates or updates a Firewall Manager resource set — a collection of resources that a Firewall Manager policy can protect as a unit. Provide the
implementation with `Effect.provide(AWS.FMS.PutResourceSetHttp)`.
### Resource Sets
**Example:** Create a Resource Set
```typescript
// init — account-level binding takes no resource
const putResourceSet = yield* AWS.FMS.PutResourceSet();

// runtime
const result = yield* putResourceSet({
  ResourceSet: {
    Name: "edge-resources",
    ResourceTypeList: ["AWS::NetworkFirewall::Firewall"],
  },
});
console.log(result.ResourceSet.Id);
```

@binding

## PutResourceSet.Request

Request for {@link PutResourceSet}.
