<!-- Docs for the generated AWS.EKS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeAccessEntry

Runtime binding for `eks:DescribeAccessEntry`.

Reads one access entry — the Kubernetes username, groups, and type mapped to an IAM principal.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeAccessEntry` is granted on the cluster's sub-resource ARNs.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeAccessEntryHttp)`.
### Inspecting Identity and Access
**Example:** Read an Access Entry
```typescript
// init
const describeAccessEntry = yield* AWS.EKS.DescribeAccessEntry(cluster);

// runtime
const { accessEntry } = yield* describeAccessEntry({ principalArn });
```

@binding

## DescribeAddon

Runtime binding for `eks:DescribeAddon`.

Reads one installed add-on's state — version, status, health issues, and pod identity associations.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeAddon` is granted on the cluster's sub-resource ARNs.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeAddonHttp)`.
### Inspecting Add-ons
**Example:** Check an Add-on's Version and Health
```typescript
// init
const describeAddon = yield* AWS.EKS.DescribeAddon(cluster);

// runtime
const { addon } = yield* describeAddon({ addonName: "vpc-cni" });
```

@binding

## DescribeAddonConfiguration

Runtime binding for `eks:DescribeAddonConfiguration`.

Reads an add-on version's configuration JSON schema — the shape its `configurationValues` must satisfy.
`eks:DescribeAddonConfiguration` is granted on `*` — the operation is account-scoped and takes no resource.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeAddonConfigurationHttp)`.
### Version Catalogs
**Example:** Read an Add-on's Configuration Schema
```typescript
// init
const describeAddonConfiguration =
  yield* AWS.EKS.DescribeAddonConfiguration();

// runtime
const { configurationSchema } = yield* describeAddonConfiguration({
  addonName: "vpc-cni",
  addonVersion,
});
```

@binding

## DescribeAddonVersions

Runtime binding for `eks:DescribeAddonVersions`.

Reads the add-on catalog — which add-ons (and versions) are available, per Kubernetes version.
`eks:DescribeAddonVersions` is granted on `*` — the operation is account-scoped and takes no resource.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeAddonVersionsHttp)`.
### Version Catalogs
**Example:** Find Compatible vpc-cni Versions
```typescript
// init
const describeAddonVersions = yield* AWS.EKS.DescribeAddonVersions();

// runtime
const { addons } = yield* describeAddonVersions({
  addonName: "vpc-cni",
  kubernetesVersion: "1.31",
});
```

@binding

## DescribeCapability

Runtime binding for `eks:DescribeCapability`.

Reads one EKS capability's full state — the managed capability (e.g. Argo CD) installed on the bound cluster, its status, version, and configuration.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeCapability` is granted on the cluster's sub-resource ARNs.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeCapabilityHttp)`.
### Cluster Capabilities
**Example:** Check a Capability's Status
```typescript
// init
const describeCapability = yield* AWS.EKS.DescribeCapability(cluster);

// runtime
const { capability } = yield* describeCapability({ capabilityName: "argocd" });
const status = capability?.status;
```

@binding

## DescribeCluster

Runtime binding for `eks:DescribeCluster`.

Reads the bound cluster's live control-plane state — status, Kubernetes API `endpoint`, `certificateAuthority` data, version, and network config. The building block for constructing a kubeconfig at runtime.
The cluster `name` is injected from the bound {@link Cluster} and `eks:DescribeCluster` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeClusterHttp)`.
### Reading Cluster State
**Example:** Build Kubernetes Connection Settings at Runtime
```typescript
// init
const describeCluster = yield* AWS.EKS.DescribeCluster(cluster);

// runtime
const { cluster: live } = yield* describeCluster();
const endpoint = live?.endpoint;
const caData = live?.certificateAuthority?.data;
```

@binding

## DescribeClusterVersions

Runtime binding for `eks:DescribeClusterVersions`.

Reads the Kubernetes version catalog — which versions EKS currently offers, their support status, and end-of-support dates.
`eks:DescribeClusterVersions` is granted on `*` — the operation is account-scoped and takes no resource.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeClusterVersionsHttp)`.
### Version Catalogs
**Example:** Find the Default Kubernetes Version
```typescript
// init
const describeClusterVersions = yield* AWS.EKS.DescribeClusterVersions();

// runtime
const { clusterVersions } = yield* describeClusterVersions({
  defaultOnly: true,
});
```

@binding

## DescribeFargateProfile

Runtime binding for `eks:DescribeFargateProfile`.

Reads one Fargate profile's state — pod execution role, selectors, subnets, and status.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeFargateProfile` is granted on the cluster's sub-resource ARNs.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeFargateProfileHttp)`.
### Inspecting Compute
**Example:** Read a Fargate Profile
```typescript
// init
const describeFargateProfile = yield* AWS.EKS.DescribeFargateProfile(cluster);

// runtime
const { fargateProfile } = yield* describeFargateProfile({
  fargateProfileName: "default",
});
```

@binding

## DescribeIdentityProviderConfig

Runtime binding for `eks:DescribeIdentityProviderConfig`.

Reads one OIDC identity provider configuration associated with the bound cluster — issuer URL, client ID, claim mappings, and association status.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeIdentityProviderConfig` is granted on the cluster's sub-resource ARNs.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeIdentityProviderConfigHttp)`.
### Identity Provider Configs
**Example:** Read an OIDC Identity Provider Config
```typescript
// init
const describeIdentityProviderConfig =
  yield* AWS.EKS.DescribeIdentityProviderConfig(cluster);

// runtime
const { identityProviderConfig } = yield* describeIdentityProviderConfig({
  identityProviderConfig: { type: "oidc", name: "corp-oidc" },
});
const issuer = identityProviderConfig?.oidc?.issuerUrl;
```

@binding

## DescribeInsight

Runtime binding for `eks:DescribeInsight`.

Reads one insight's full detail — category, status, recommendation, and the resources it flags.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeInsight` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeInsightHttp)`.
### Cluster Insights
**Example:** Read an Insight's Recommendation
```typescript
// init
const describeInsight = yield* AWS.EKS.DescribeInsight(cluster);

// runtime
const { insight } = yield* describeInsight({ id: insightId });
```

@binding

## DescribeInsightsRefresh

Runtime binding for `eks:DescribeInsightsRefresh`.

Reads the status of the bound cluster's insights refresh — whether an on-demand refresh (kicked off via {@link StartInsightsRefresh}) is in progress, completed, or failed.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeInsightsRefresh` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeInsightsRefreshHttp)`.
### Cluster Insights
**Example:** Check an Insights Refresh's Status
```typescript
// init
const describeInsightsRefresh = yield* AWS.EKS.DescribeInsightsRefresh(cluster);

// runtime
const { status } = yield* describeInsightsRefresh();
```

@binding

## DescribeNodegroup

Runtime binding for `eks:DescribeNodegroup`.

Reads one managed node group's full state — scaling config, instance types, AMI release version, health issues.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribeNodegroup` is granted on the cluster's sub-resource ARNs.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeNodegroupHttp)`.
### Inspecting Compute
**Example:** Check a Node Group's Health
```typescript
// init
const describeNodegroup = yield* AWS.EKS.DescribeNodegroup(cluster);

// runtime
const { nodegroup } = yield* describeNodegroup({ nodegroupName: "general" });
const issues = nodegroup?.health?.issues ?? [];
```

@binding

## DescribePodIdentityAssociation

Runtime binding for `eks:DescribePodIdentityAssociation`.

Reads one EKS Pod Identity association — the IAM role wired to a Kubernetes service account.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:DescribePodIdentityAssociation` is granted on the cluster's sub-resource ARNs.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribePodIdentityAssociationHttp)`.
### Inspecting Identity and Access
**Example:** Read a Pod Identity Association
```typescript
// init
const describePodIdentityAssociation =
  yield* AWS.EKS.DescribePodIdentityAssociation(cluster);

// runtime
const { association } = yield* describePodIdentityAssociation({
  associationId,
});
```

@binding

## DescribeUpdate

Runtime binding for `eks:DescribeUpdate`.

Reads one update's status and parameters — poll it to track an in-flight version upgrade or config change.
The cluster `name` is injected from the bound {@link Cluster} and `eks:DescribeUpdate` is granted on the cluster's ARN and sub-resource ARNs.
Provide the implementation with
`Effect.provide(AWS.EKS.DescribeUpdateHttp)`.
### Tracking Updates
**Example:** Poll an Update's Status
```typescript
// init
const describeUpdate = yield* AWS.EKS.DescribeUpdate(cluster);

// runtime
const { update } = yield* describeUpdate({ updateId });
const done = update?.status === "Successful";
```

@binding

## ListAccessEntries

Runtime binding for `eks:ListAccessEntries`.

Enumerates the IAM principal ARNs granted Kubernetes access to the bound cluster via access entries.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListAccessEntries` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.ListAccessEntriesHttp)`.
### Inspecting Identity and Access
**Example:** List Access Entries
```typescript
// init
const listAccessEntries = yield* AWS.EKS.ListAccessEntries(cluster);

// runtime
const { accessEntries } = yield* listAccessEntries();
```

@binding

## ListAccessPolicies

Runtime binding for `eks:ListAccessPolicies`.

Enumerates the AWS-managed EKS access policies (`AmazonEKSAdminPolicy`, `AmazonEKSViewPolicy`, …) that can be associated with access entries.
`eks:ListAccessPolicies` is granted on `*` — the operation is account-scoped and takes no resource.
Provide the implementation with
`Effect.provide(AWS.EKS.ListAccessPoliciesHttp)`.
### Discovering Clusters
**Example:** List the Managed Access Policies
```typescript
// init
const listAccessPolicies = yield* AWS.EKS.ListAccessPolicies();

// runtime
const { accessPolicies } = yield* listAccessPolicies();
```

@binding

## ListAddons

Runtime binding for `eks:ListAddons`.

Enumerates the add-on names installed on the bound cluster.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListAddons` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.ListAddonsHttp)`.
### Inspecting Add-ons
**Example:** List Installed Add-ons
```typescript
// init
const listAddons = yield* AWS.EKS.ListAddons(cluster);

// runtime
const { addons } = yield* listAddons();
```

@binding

## ListAssociatedAccessPolicies

Runtime binding for `eks:ListAssociatedAccessPolicies`.

Enumerates the EKS access policies associated with one access entry's IAM principal.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListAssociatedAccessPolicies` is granted on the cluster's sub-resource ARNs.
Provide the implementation with
`Effect.provide(AWS.EKS.ListAssociatedAccessPoliciesHttp)`.
### Inspecting Identity and Access
**Example:** List a Principal's Access Policies
```typescript
// init
const listAssociatedAccessPolicies =
  yield* AWS.EKS.ListAssociatedAccessPolicies(cluster);

// runtime
const { associatedAccessPolicies } = yield* listAssociatedAccessPolicies({
  principalArn,
});
```

@binding

## ListCapabilities

Runtime binding for `eks:ListCapabilities`.

Enumerates the managed capabilities (e.g. Argo CD) installed on the bound cluster.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListCapabilities` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.ListCapabilitiesHttp)`.
### Cluster Capabilities
**Example:** List Installed Capabilities
```typescript
// init
const listCapabilities = yield* AWS.EKS.ListCapabilities(cluster);

// runtime
const { capabilities } = yield* listCapabilities();
```

@binding

## ListClusters

Runtime binding for `eks:ListClusters`.

Enumerates the EKS cluster names in the caller's account and region.
`eks:ListClusters` is granted on `*` — the operation is account-scoped and takes no resource.
Provide the implementation with
`Effect.provide(AWS.EKS.ListClustersHttp)`.
### Discovering Clusters
**Example:** List All Clusters
```typescript
// init
const listClusters = yield* AWS.EKS.ListClusters();

// runtime
const { clusters } = yield* listClusters();
```

@binding

## ListFargateProfiles

Runtime binding for `eks:ListFargateProfiles`.

Enumerates the Fargate profile names configured on the bound cluster.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListFargateProfiles` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.ListFargateProfilesHttp)`.
### Inspecting Compute
**Example:** List Fargate Profiles
```typescript
// init
const listFargateProfiles = yield* AWS.EKS.ListFargateProfiles(cluster);

// runtime
const { fargateProfileNames } = yield* listFargateProfiles();
```

@binding

## ListIdentityProviderConfigs

Runtime binding for `eks:ListIdentityProviderConfigs`.

Enumerates the OIDC identity provider configurations associated with the bound cluster.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListIdentityProviderConfigs` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.ListIdentityProviderConfigsHttp)`.
### Identity Provider Configs
**Example:** List OIDC Identity Provider Configs
```typescript
// init
const listIdentityProviderConfigs =
  yield* AWS.EKS.ListIdentityProviderConfigs(cluster);

// runtime
const { identityProviderConfigs } = yield* listIdentityProviderConfigs();
```

@binding

## ListInsights

Runtime binding for `eks:ListInsights`.

Enumerates EKS upgrade/configuration insights for the bound cluster — findings that block or degrade a Kubernetes version upgrade.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListInsights` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.ListInsightsHttp)`.
### Cluster Insights
**Example:** List Upgrade-Blocking Insights
```typescript
// init
const listInsights = yield* AWS.EKS.ListInsights(cluster);

// runtime
const { insights } = yield* listInsights({
  filter: { statuses: ["ERROR", "WARNING"] },
});
```

@binding

## ListNodegroups

Runtime binding for `eks:ListNodegroups`.

Enumerates the managed node group names attached to the bound cluster.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListNodegroups` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.ListNodegroupsHttp)`.
### Inspecting Compute
**Example:** List the Cluster's Node Groups
```typescript
// init
const listNodegroups = yield* AWS.EKS.ListNodegroups(cluster);

// runtime
const { nodegroups } = yield* listNodegroups();
```

@binding

## ListPodIdentityAssociations

Runtime binding for `eks:ListPodIdentityAssociations`.

Enumerates the EKS Pod Identity associations on the bound cluster, optionally filtered by namespace or service account.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListPodIdentityAssociations` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.ListPodIdentityAssociationsHttp)`.
### Inspecting Identity and Access
**Example:** List Pod Identity Associations in a Namespace
```typescript
// init
const listPodIdentityAssociations =
  yield* AWS.EKS.ListPodIdentityAssociations(cluster);

// runtime
const { associations } = yield* listPodIdentityAssociations({
  namespace: "default",
});
```

@binding

## ListUpdates

Runtime binding for `eks:ListUpdates`.

Enumerates the update IDs issued against the bound cluster (or one of its node groups / add-ons).
The cluster `name` is injected from the bound {@link Cluster} and `eks:ListUpdates` is granted on the cluster's ARN and sub-resource ARNs.
Provide the implementation with
`Effect.provide(AWS.EKS.ListUpdatesHttp)`.
### Tracking Updates
**Example:** List Cluster Updates
```typescript
// init
const listUpdates = yield* AWS.EKS.ListUpdates(cluster);

// runtime
const { updateIds } = yield* listUpdates();
```

@binding

## StartInsightsRefresh

Runtime binding for `eks:StartInsightsRefresh`.

Kicks off an on-demand refresh of the bound cluster's upgrade/configuration insights instead of waiting for the periodic automatic evaluation. Track progress with {@link DescribeInsightsRefresh}.
The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:StartInsightsRefresh` is granted on the cluster's ARN.
Provide the implementation with
`Effect.provide(AWS.EKS.StartInsightsRefreshHttp)`.
### Cluster Insights
**Example:** Refresh Insights Before an Upgrade Check
```typescript
// init
const startInsightsRefresh = yield* AWS.EKS.StartInsightsRefresh(cluster);

// runtime
const { status } = yield* startInsightsRefresh();
```

@binding
