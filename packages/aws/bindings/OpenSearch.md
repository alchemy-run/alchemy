<!-- Docs for the generated AWS.OpenSearch bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelServiceSoftwareUpdate

Runtime binding for the `CancelServiceSoftwareUpdate` operation (IAM action
`es:CancelServiceSoftwareUpdate`).

Cancels a scheduled service software update — only while the update is in the `PENDING_UPDATE` state. Provide the implementation with
`Effect.provide(AWS.OpenSearch.CancelServiceSoftwareUpdateHttp)`.
### Service Software Updates
**Example:** Cancel a Pending Update
```typescript
const cancelServiceSoftwareUpdate = yield* OpenSearch.CancelServiceSoftwareUpdate();

const result = yield* cancelServiceSoftwareUpdate({ DomainName: name });
// result.ServiceSoftwareOptions?.UpdateStatus → "NOT_ELIGIBLE" | "ELIGIBLE"
```

@binding

## DescribeDomain

Runtime binding for the `DescribeDomain` operation (IAM action
`es:DescribeDomain`).

Reads a domain's current status — endpoint, engine version, creation and processing state — e.g. an operational health check that verifies a domain is active before routing search traffic. Provide the implementation with
`Effect.provide(AWS.OpenSearch.DescribeDomainHttp)`.
### Monitoring Domains
**Example:** Check a Domain's Status
```typescript
const describeDomain = yield* OpenSearch.DescribeDomain();

const result = yield* describeDomain({ DomainName: name });
// result.DomainStatus.Processing → false
```

@binding

## DescribeDomainAutoTunes

Runtime binding for the `DescribeDomainAutoTunes` operation (IAM action
`es:DescribeDomainAutoTunes`).

Lists the Auto-Tune optimizations scheduled for a domain — e.g. to surface upcoming JVM heap or queue tuning actions to operators. Provide the implementation with
`Effect.provide(AWS.OpenSearch.DescribeDomainAutoTunesHttp)`.
### Auto-Tune and Scheduled Actions
**Example:** List Scheduled Auto-Tune Optimizations
```typescript
const describeDomainAutoTunes = yield* OpenSearch.DescribeDomainAutoTunes();

const result = yield* describeDomainAutoTunes({ DomainName: name });
// result.AutoTunes → scheduled optimizations
```

@binding

## DescribeDomainChangeProgress

Runtime binding for the `DescribeDomainChangeProgress` operation (IAM action
`es:DescribeDomainChangeProgress`).

Tracks the stage-by-stage progress of a domain's in-flight configuration change (blue/green deployment) — e.g. to report how far along a cluster resize is. Provide the implementation with
`Effect.provide(AWS.OpenSearch.DescribeDomainChangeProgressHttp)`.
### Monitoring Domains
**Example:** Track a Configuration Change
```typescript
const describeDomainChangeProgress = yield* OpenSearch.DescribeDomainChangeProgress();

const result = yield* describeDomainChangeProgress({ DomainName: name });
// result.ChangeProgressStatus?.Status → "COMPLETED"
```

@binding

## DescribeDomainConfig

Runtime binding for the `DescribeDomainConfig` operation (IAM action
`es:DescribeDomainConfig`).

Reads a domain's full configuration, with per-option status metadata (update date, state, pending values) — the authoritative view of what a blue/green change is converging toward. Provide the implementation with
`Effect.provide(AWS.OpenSearch.DescribeDomainConfigHttp)`.
### Monitoring Domains
**Example:** Read a Domain's Configuration
```typescript
const describeDomainConfig = yield* OpenSearch.DescribeDomainConfig();

const result = yield* describeDomainConfig({ DomainName: name });
// result.DomainConfig.ClusterConfig?.Status.State → "Active"
```

@binding

## DescribeDomainHealth

Runtime binding for the `DescribeDomainHealth` operation (IAM action
`es:DescribeDomainHealth`).

Reads a domain's cluster health — overall status, master eligibility, per-AZ shard and node distribution — for dashboards and automated health checks. Provide the implementation with
`Effect.provide(AWS.OpenSearch.DescribeDomainHealthHttp)`.
### Monitoring Domains
**Example:** Check Cluster Health
```typescript
const describeDomainHealth = yield* OpenSearch.DescribeDomainHealth();

const result = yield* describeDomainHealth({ DomainName: name });
// result.ClusterHealth → "Green"
```

@binding

## DescribeDomainNodes

Runtime binding for the `DescribeDomainNodes` operation (IAM action
`es:DescribeDomainNodes`).

Lists a domain's individual nodes — type (data/master/UltraWarm), Availability Zone, instance type, and storage — for node-level diagnostics. Provide the implementation with
`Effect.provide(AWS.OpenSearch.DescribeDomainNodesHttp)`.
### Monitoring Domains
**Example:** List a Domain's Nodes
```typescript
const describeDomainNodes = yield* OpenSearch.DescribeDomainNodes();

const result = yield* describeDomainNodes({ DomainName: name });
// result.DomainNodesStatusList → one entry per node
```

@binding

## DescribeDomains

Runtime binding for the `DescribeDomains` operation (IAM action
`es:DescribeDomains`).

Reads the current status of up to five domains in one call — the batch form of `DescribeDomain`. Provide the implementation with
`Effect.provide(AWS.OpenSearch.DescribeDomainsHttp)`.
### Monitoring Domains
**Example:** Check Several Domains at Once
```typescript
const describeDomains = yield* OpenSearch.DescribeDomains();

const result = yield* describeDomains({ DomainNames: [a, b] });
// result.DomainStatusList → one status per domain
```

@binding

## GetCompatibleVersions

Runtime binding for the `GetCompatibleVersions` operation (IAM action
`es:GetCompatibleVersions`).

Maps engine versions to the versions they can be upgraded to — for one domain (pass `DomainName`) or for every supported version. Provide the implementation with
`Effect.provide(AWS.OpenSearch.GetCompatibleVersionsHttp)`.
### Engine Upgrades
**Example:** Find Valid Upgrade Targets
```typescript
const getCompatibleVersions = yield* OpenSearch.GetCompatibleVersions();

const result = yield* getCompatibleVersions({ DomainName: name });
// result.CompatibleVersions?.[0]?.TargetVersions → upgrade targets
```

@binding

## GetDomainMaintenanceStatus

Runtime binding for the `GetDomainMaintenanceStatus` operation (IAM action
`es:GetDomainMaintenanceStatus`).

Reads the status of one in-progress or completed maintenance action started with `StartDomainMaintenance`. Provide the implementation with
`Effect.provide(AWS.OpenSearch.GetDomainMaintenanceStatusHttp)`.
### Domain Maintenance
**Example:** Check a Maintenance Action
```typescript
const getDomainMaintenanceStatus = yield* OpenSearch.GetDomainMaintenanceStatus();

const result = yield* getDomainMaintenanceStatus({
  DomainName: name,
  MaintenanceId: maintenanceId,
});
// result.Status → "COMPLETED"
```

@binding

## GetUpgradeHistory

Runtime binding for the `GetUpgradeHistory` operation (IAM action
`es:GetUpgradeHistory`).

Lists a domain's past engine-version upgrades and upgrade-eligibility checks, with per-step progress. Provide the implementation with
`Effect.provide(AWS.OpenSearch.GetUpgradeHistoryHttp)`.
### Engine Upgrades
**Example:** List Past Upgrades
```typescript
const getUpgradeHistory = yield* OpenSearch.GetUpgradeHistory();

const result = yield* getUpgradeHistory({ DomainName: name });
// result.UpgradeHistories → past upgrades
```

@binding

## GetUpgradeStatus

Runtime binding for the `GetUpgradeStatus` operation (IAM action
`es:GetUpgradeStatus`).

Reads the status of a domain's most recent engine-version upgrade or upgrade-eligibility check. Provide the implementation with
`Effect.provide(AWS.OpenSearch.GetUpgradeStatusHttp)`.
### Engine Upgrades
**Example:** Check an In-Progress Upgrade
```typescript
const getUpgradeStatus = yield* OpenSearch.GetUpgradeStatus();

const result = yield* getUpgradeStatus({ DomainName: name });
// result.StepStatus → "SUCCEEDED"
```

@binding

## ListDomainMaintenances

Runtime binding for the `ListDomainMaintenances` operation (IAM action
`es:ListDomainMaintenances`).

Lists a domain's maintenance actions — status and timestamps of past and in-progress reboots and process restarts. Provide the implementation with
`Effect.provide(AWS.OpenSearch.ListDomainMaintenancesHttp)`.
### Domain Maintenance
**Example:** List a Domain's Maintenance History
```typescript
const listDomainMaintenances = yield* OpenSearch.ListDomainMaintenances();

const result = yield* listDomainMaintenances({ DomainName: name });
// result.DomainMaintenances → maintenance history
```

@binding

## ListDomainNames

Runtime binding for the `ListDomainNames` operation (IAM action
`es:ListDomainNames`).

Lists the names and engine types of all domains the account owns in the active Region — the entry point for fleet-wide monitoring. Provide the implementation with
`Effect.provide(AWS.OpenSearch.ListDomainNamesHttp)`.
### Monitoring Domains
**Example:** List the Account's Domains
```typescript
const listDomainNames = yield* OpenSearch.ListDomainNames();

const result = yield* listDomainNames();
// result.DomainNames → [{ DomainName, EngineType }, …]
```

@binding

## ListInstanceTypeDetails

Runtime binding for the `ListInstanceTypeDetails` operation (IAM action
`es:ListInstanceTypeDetails`).

Lists the instance types (and their capabilities — encryption, warm storage, app logs) supported by an engine version, e.g. to validate a resize before applying it. Provide the implementation with
`Effect.provide(AWS.OpenSearch.ListInstanceTypeDetailsHttp)`.
### Engine Catalog
**Example:** List Instance Types for a Version
```typescript
const listInstanceTypeDetails = yield* OpenSearch.ListInstanceTypeDetails();

const result = yield* listInstanceTypeDetails({
  EngineVersion: "OpenSearch_2.19",
});
// result.InstanceTypeDetails → supported instance types
```

@binding

## ListScheduledActions

Runtime binding for the `ListScheduledActions` operation (IAM action
`es:ListScheduledActions`).

Lists the actions scheduled on a domain — service software updates, blue/green Auto-Tune changes — with their scheduled time and severity. Provide the implementation with
`Effect.provide(AWS.OpenSearch.ListScheduledActionsHttp)`.
### Auto-Tune and Scheduled Actions
**Example:** List a Domain's Scheduled Actions
```typescript
const listScheduledActions = yield* OpenSearch.ListScheduledActions();

const result = yield* listScheduledActions({ DomainName: name });
// result.ScheduledActions → pending actions
```

@binding

## ListVersions

Runtime binding for the `ListVersions` operation (IAM action
`es:ListVersions`).

Lists every OpenSearch and Elasticsearch version the service supports — e.g. to validate an upgrade target before calling the upgrade API. Provide the implementation with
`Effect.provide(AWS.OpenSearch.ListVersionsHttp)`.
### Engine Catalog
**Example:** List Supported Engine Versions
```typescript
const listVersions = yield* OpenSearch.ListVersions();

const result = yield* listVersions();
// result.Versions → ["OpenSearch_2.19", …]
```

@binding

## StartDomainMaintenance

Runtime binding for the `StartDomainMaintenance` operation (IAM action
`es:StartDomainMaintenance`).

Starts a maintenance action on a domain — reboot a node, restart the search process, or restart Dashboards — e.g. remediation triggered by a health alarm. Provide the implementation with
`Effect.provide(AWS.OpenSearch.StartDomainMaintenanceHttp)`.
### Domain Maintenance
**Example:** Reboot a Data Node
```typescript
const startDomainMaintenance = yield* OpenSearch.StartDomainMaintenance();

const result = yield* startDomainMaintenance({
  DomainName: name,
  Action: "REBOOT_NODE",
  NodeId: nodeId,
});
// result.MaintenanceId → track with GetDomainMaintenanceStatus
```

@binding

## StartServiceSoftwareUpdate

Runtime binding for the `StartServiceSoftwareUpdate` operation (IAM action
`es:StartServiceSoftwareUpdate`).

Schedules a service software update for a domain — immediately, at a timestamp, or in the domain's off-peak window — e.g. rolling out a pending security patch fleet-wide. Provide the implementation with
`Effect.provide(AWS.OpenSearch.StartServiceSoftwareUpdateHttp)`.
### Service Software Updates
**Example:** Start a Service Software Update
```typescript
const startServiceSoftwareUpdate = yield* OpenSearch.StartServiceSoftwareUpdate();

const result = yield* startServiceSoftwareUpdate({ DomainName: name });
// result.ServiceSoftwareOptions?.UpdateStatus → "PENDING_UPDATE"
```

@binding
