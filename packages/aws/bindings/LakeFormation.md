<!-- Docs for the generated AWS.LakeFormation bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetDataLakePrincipal

Runtime binding for `lakeformation:GetDataLakePrincipal`.

Returns the identity of the calling principal as Lake Formation sees it —
useful for logging/auditing which data-lake principal a function acts as.
Provide the implementation with
`Effect.provide(AWS.LakeFormation.GetDataLakePrincipalHttp)`.
### Identifying the Caller
**Example:** Read the Calling Data Lake Principal
```typescript
// init — account-level binding takes no resource
const getDataLakePrincipal = yield* AWS.LakeFormation.GetDataLakePrincipal();

// runtime
const { Identity } = yield* getDataLakePrincipal();
```

@binding

## GetDataLakePrincipal.Request

Request for {@link GetDataLakePrincipal}.

## GetEffectivePermissionsForPath

Runtime binding for `lakeformation:GetEffectivePermissionsForPath`.

Returns the Lake Formation permissions in effect for the databases and
tables stored under a registered S3 path — an authorization audit for a
data location. Provide the implementation with
`Effect.provide(AWS.LakeFormation.GetEffectivePermissionsForPathHttp)`.
### Auditing Permissions
**Example:** Audit Permissions on a Registered Location
```typescript
// init — account-level binding takes no resource
const getEffectivePermissions =
  yield* AWS.LakeFormation.GetEffectivePermissionsForPath();

// runtime
const { Permissions } = yield* getEffectivePermissions({
  ResourceArn: location.resourceArn,
});
```

@binding

## GetEffectivePermissionsForPath.Request

Request for {@link GetEffectivePermissionsForPath}.

## GetLFTag

Runtime binding for `lakeformation:GetLFTag`.

Reads one LF-tag definition (its allowed values) by key. Provide the
implementation with `Effect.provide(AWS.LakeFormation.GetLFTagHttp)`.
### Reading LF-Tags
**Example:** Read a Tag Definition
```typescript
// init — account-level binding takes no resource
const getLFTag = yield* AWS.LakeFormation.GetLFTag();

// runtime
const { TagValues } = yield* getLFTag({ TagKey: "environment" });
```

@binding

## GetLFTag.Request

Request for {@link GetLFTag}.

## GetResourceLFTags

Runtime binding for `lakeformation:GetResourceLFTags`.

Reads the LF-tags attached to a Data Catalog resource (database, table,
or columns) — lets a function make tag-driven decisions about the data it
touches. Provide the implementation with
`Effect.provide(AWS.LakeFormation.GetResourceLFTagsHttp)`.
### Reading LF-Tags
**Example:** Read a Database's LF-Tags
```typescript
// init — account-level binding takes no resource
const getResourceLFTags = yield* AWS.LakeFormation.GetResourceLFTags();

// runtime
const { LFTagOnDatabase } = yield* getResourceLFTags({
  Resource: { Database: { Name: database.databaseName } },
});
```

@binding

## GetResourceLFTags.Request

Request for {@link GetResourceLFTags}.

## GetTemporaryDataLocationCredentials

Runtime binding for `lakeformation:GetDataAccess` (data-location scope).

Vends temporary S3 credentials for registered data locations the caller
holds `DATA_LOCATION_ACCESS` on. The returned credentials'
`SecretAccessKey` and `SessionToken` are `Redacted`. Provide the
implementation with
`Effect.provide(AWS.LakeFormation.GetTemporaryDataLocationCredentialsHttp)`.
### Vending Data Access Credentials
**Example:** Vend Location-Scoped S3 Credentials
```typescript
// init — account-level binding takes no resource
const getLocationCredentials =
  yield* AWS.LakeFormation.GetTemporaryDataLocationCredentials();

// runtime
const { Credentials } = yield* getLocationCredentials({
  DataLocations: [location.resourceArn],
  CredentialsScope: "READ",
});
```

@binding

## GetTemporaryDataLocationCredentials.Request

Request for {@link GetTemporaryDataLocationCredentials}.

## GetTemporaryGlueTableCredentials

Runtime binding for `lakeformation:GetDataAccess` (table scope).

Vends temporary S3 credentials scoped down to the storage of one Glue
table, enforcing the caller's Lake Formation grants — the credential
vending API used by query engines. The returned `SecretAccessKey` and
`SessionToken` are `Redacted`. Provide the implementation with
`Effect.provide(AWS.LakeFormation.GetTemporaryGlueTableCredentialsHttp)`.
### Vending Data Access Credentials
**Example:** Vend Table-Scoped S3 Credentials
```typescript
// init — account-level binding takes no resource
const getTableCredentials =
  yield* AWS.LakeFormation.GetTemporaryGlueTableCredentials();

// runtime
const credentials = yield* getTableCredentials({
  TableArn: table.tableArn,
  Permissions: ["SELECT"],
  SupportedPermissionTypes: ["COLUMN_PERMISSION"],
});
const secret = Redacted.value(credentials.SecretAccessKey!);
```

@binding

## GetTemporaryGlueTableCredentials.Request

Request for {@link GetTemporaryGlueTableCredentials}.

## ListLFTags

Runtime binding for `lakeformation:ListLFTags`.

Lists the LF-tag definitions visible to the caller. Provide the
implementation with `Effect.provide(AWS.LakeFormation.ListLFTagsHttp)`.
### Reading LF-Tags
**Example:** List Visible Tag Definitions
```typescript
// init — account-level binding takes no resource
const listLFTags = yield* AWS.LakeFormation.ListLFTags();

// runtime
const { LFTags } = yield* listLFTags();
```

@binding

## ListLFTags.Request

Request for {@link ListLFTags}.

## ListPermissions

Runtime binding for `lakeformation:ListPermissions`.

Lists the Lake Formation permission grants visible to the caller,
optionally filtered by principal or resource — runtime authorization
introspection. Provide the implementation with
`Effect.provide(AWS.LakeFormation.ListPermissionsHttp)`.
### Auditing Permissions
**Example:** List Grants on a Database
```typescript
// init — account-level binding takes no resource
const listPermissions = yield* AWS.LakeFormation.ListPermissions();

// runtime
const { PrincipalResourcePermissions } = yield* listPermissions({
  Resource: { Database: { Name: database.databaseName } },
});
```

@binding

## ListPermissions.Request

Request for {@link ListPermissions}.

## SearchDatabasesByLFTags

Runtime binding for `lakeformation:SearchDatabasesByLFTags`.

Finds Glue databases whose LF-tags match an expression — tag-driven data
discovery at runtime. Provide the implementation with
`Effect.provide(AWS.LakeFormation.SearchDatabasesByLFTagsHttp)`.
### Searching by LF-Tags
**Example:** Find Databases Tagged prod
```typescript
// init — account-level binding takes no resource
const searchDatabases = yield* AWS.LakeFormation.SearchDatabasesByLFTags();

// runtime
const { DatabaseList } = yield* searchDatabases({
  Expression: [{ TagKey: "environment", TagValues: ["prod"] }],
});
```

@binding

## SearchDatabasesByLFTags.Request

Request for {@link SearchDatabasesByLFTags}.

## SearchTablesByLFTags

Runtime binding for `lakeformation:SearchTablesByLFTags`.

Finds Glue tables whose LF-tags match an expression — tag-driven data
discovery at runtime. Provide the implementation with
`Effect.provide(AWS.LakeFormation.SearchTablesByLFTagsHttp)`.
### Searching by LF-Tags
**Example:** Find Tables Tagged pii
```typescript
// init — account-level binding takes no resource
const searchTables = yield* AWS.LakeFormation.SearchTablesByLFTags();

// runtime
const { TableList } = yield* searchTables({
  Expression: [{ TagKey: "classification", TagValues: ["pii"] }],
});
```

@binding

## SearchTablesByLFTags.Request

Request for {@link SearchTablesByLFTags}.
