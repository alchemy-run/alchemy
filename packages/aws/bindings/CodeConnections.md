<!-- Docs for the generated AWS.CodeConnections bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetConnection

Runtime binding for `codeconnections:GetConnection`.

Bind this operation to a {@link Connection} to read the connection's live
state — status (`PENDING`/`AVAILABLE`/`ERROR`), provider type, and owner —
from inside a function runtime. Useful for workloads that gate work on the
connection's OAuth handshake having been completed. Provide the
implementation with `Effect.provide(AWS.CodeConnections.GetConnectionHttp)`.
### Inspecting a Connection
**Example:** Gate on the Connection Being AVAILABLE
```typescript
// init — bind the operation to the connection
const getConnection = yield* AWS.CodeConnections.GetConnection(connection);

// runtime
const { Connection: live } = yield* getConnection();
if (live?.ConnectionStatus !== "AVAILABLE") {
  return yield* HttpServerResponse.text("handshake pending", { status: 409 });
}
```

@binding

## GetRepositorySyncStatus

Runtime binding for `codeconnections:GetRepositorySyncStatus`.

Bind this operation to a {@link RepositoryLink} to read the latest Git
sync attempt for a branch — its status and the sync events that led to
it — from inside a function runtime. Useful for dashboards that surface
whether a stack is in sync with its repository. Provide the
implementation with
`Effect.provide(AWS.CodeConnections.GetRepositorySyncStatusHttp)`.
### Monitoring Git Sync
**Example:** Read a Branch's Latest Sync Attempt
```typescript
// init — bind the operation to the repository link
const getRepositorySyncStatus =
  yield* AWS.CodeConnections.GetRepositorySyncStatus(link);

// runtime
const { LatestSync } = yield* getRepositorySyncStatus({
  Branch: "main",
  SyncType: "CFN_STACK_SYNC",
});
```

@binding

## GetRepositorySyncStatus.Request

Request for {@link GetRepositorySyncStatus} — the branch and sync type to
read; the repository link ID is injected from the bound resource.

## GetResourceSyncStatus

Runtime binding for `codeconnections:GetResourceSyncStatus`.

Bind this operation to a {@link SyncConfiguration} to read the sync
status of its Amazon Web Services resource — the desired state revision
and the latest successful/attempted syncs — from inside a function
runtime. Provide the implementation with
`Effect.provide(AWS.CodeConnections.GetResourceSyncStatusHttp)`.
### Monitoring Git Sync
**Example:** Read the Resource's Sync Status
```typescript
// init — bind the operation to the sync configuration
const getResourceSyncStatus =
  yield* AWS.CodeConnections.GetResourceSyncStatus(sync);

// runtime
const { LatestSync } = yield* getResourceSyncStatus();
```

@binding

## GetSyncBlockerSummary

Runtime binding for `codeconnections:GetSyncBlockerSummary`.

Bind this operation to a {@link SyncConfiguration} to read the latest
sync blockers — errors that stop Git sync from converging the resource —
from inside a function runtime. Pair with {@link UpdateSyncBlocker} to
resolve them. Provide the implementation with
`Effect.provide(AWS.CodeConnections.GetSyncBlockerSummaryHttp)`.
### Monitoring Git Sync
**Example:** Read the Latest Sync Blockers
```typescript
// init — bind the operation to the sync configuration
const getSyncBlockerSummary =
  yield* AWS.CodeConnections.GetSyncBlockerSummary(sync);

// runtime
const { SyncBlockerSummary } = yield* getSyncBlockerSummary();
const blockers = SyncBlockerSummary.LatestBlockers ?? [];
```

@binding

## ListConnections

Runtime binding for `codeconnections:ListConnections`.

An account-level operation (no connection argument) that enumerates the
account's connections, optionally filtered by provider type or host.
Useful for governance sweeps that audit which source providers are wired
up. Provide the implementation with
`Effect.provide(AWS.CodeConnections.ListConnectionsHttp)`.
### Inspecting a Connection
**Example:** List Connections by Provider
```typescript
// init — account-level binding takes no resource
const listConnections = yield* AWS.CodeConnections.ListConnections();

// runtime
const result = yield* listConnections({ ProviderTypeFilter: "GitHub" });
const names = (result.Connections ?? []).map((c) => c.ConnectionName);
```

@binding

## ListConnections.Request

Request for {@link ListConnections}.

## ListHosts

Runtime binding for `codeconnections:ListHosts`.

An account-level operation (no host argument) that enumerates the
account's hosts — the self-managed provider endpoints (GitHub Enterprise
Server, GitLab self-managed) that connections attach to. Useful for
governance sweeps that audit which provider endpoints are registered.
Provide the implementation with
`Effect.provide(AWS.CodeConnections.ListHostsHttp)`.
### Inspecting a Host
**Example:** List the Account's Hosts
```typescript
// init — account-level binding takes no resource
const listHosts = yield* AWS.CodeConnections.ListHosts();

// runtime
const result = yield* listHosts();
const urls = (result.Hosts ?? []).map((h) => h.ProviderEndpoint);
```

@binding

## ListHosts.Request

Request for {@link ListHosts}.

## ListRepositoryLinks

Runtime binding for `codeconnections:ListRepositoryLinks`.

An account-level operation (no repository-link argument) that enumerates
the account's repository links — the Git-sync attachments between a
connection and a specific provider repository. Useful for sync dashboards
that discover which repositories are wired up before drilling into their
sync status. Provide the implementation with
`Effect.provide(AWS.CodeConnections.ListRepositoryLinksHttp)`.
### Monitoring Git Sync
**Example:** List the Account's Repository Links
```typescript
// init — account-level binding takes no resource
const listRepositoryLinks =
  yield* AWS.CodeConnections.ListRepositoryLinks();

// runtime
const result = yield* listRepositoryLinks();
const repos = (result.RepositoryLinks ?? []).map((l) => l.RepositoryName);
```

@binding

## ListRepositoryLinks.Request

Request for {@link ListRepositoryLinks}.

## ListRepositorySyncDefinitions

Runtime binding for `codeconnections:ListRepositorySyncDefinitions`.

Bind this operation to a {@link RepositoryLink} to enumerate the sync
definitions Git sync tracks for the link — branch, directory, and target
per definition. Provide the implementation with
`Effect.provide(AWS.CodeConnections.ListRepositorySyncDefinitionsHttp)`.
### Monitoring Git Sync
**Example:** List the Link's Sync Definitions
```typescript
// init — bind the operation to the repository link
const listRepositorySyncDefinitions =
  yield* AWS.CodeConnections.ListRepositorySyncDefinitions(link);

// runtime
const { RepositorySyncDefinitions } =
  yield* listRepositorySyncDefinitions({ SyncType: "CFN_STACK_SYNC" });
```

@binding

## ListRepositorySyncDefinitions.Request

Request for {@link ListRepositorySyncDefinitions} — the sync type to
list; the repository link ID is injected from the bound resource.

## ListSyncConfigurations

Runtime binding for `codeconnections:ListSyncConfigurations`.

Bind this operation to a {@link RepositoryLink} to enumerate the sync
configurations attached to the link — which AWS resources Git sync keeps
converged from the linked repository. Provide the implementation with
`Effect.provide(AWS.CodeConnections.ListSyncConfigurationsHttp)`.
### Monitoring Git Sync
**Example:** List the Link's Sync Configurations
```typescript
// init — bind the operation to the repository link
const listSyncConfigurations =
  yield* AWS.CodeConnections.ListSyncConfigurations(link);

// runtime
const { SyncConfigurations } =
  yield* listSyncConfigurations({ SyncType: "CFN_STACK_SYNC" });
```

@binding

## ListSyncConfigurations.Request

Request for {@link ListSyncConfigurations} — the sync type to list; the
repository link ID is injected from the bound resource.

## UpdateSyncBlocker

Runtime binding for `codeconnections:UpdateSyncBlocker`.

Bind this operation to a {@link SyncConfiguration} to resolve a sync
blocker (discovered via {@link GetSyncBlockerSummary}) so Git sync can
resume converging the resource. Provide the implementation with
`Effect.provide(AWS.CodeConnections.UpdateSyncBlockerHttp)`.
### Monitoring Git Sync
**Example:** Resolve a Sync Blocker
```typescript
// init — bind the operation to the sync configuration
const updateSyncBlocker = yield* AWS.CodeConnections.UpdateSyncBlocker(sync);

// runtime
yield* updateSyncBlocker({
  Id: blocker.Id,
  ResolvedReason: "stack drift corrected manually",
});
```

@binding

## UpdateSyncBlocker.Request

Request for {@link UpdateSyncBlocker} — the blocker ID and resolution
reason; the sync configuration's identity is injected from the bound
resource.
