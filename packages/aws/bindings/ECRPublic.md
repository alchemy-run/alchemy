<!-- Docs for the generated AWS.ECRPublic bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeRegistries

Runtime binding for `ecr-public:DescribeRegistries`.

Reads the account's public registry details — most usefully the registry
aliases that form public pull URIs (`public.ecr.aws/<alias>/<repo>`).
Provide the implementation with
`Effect.provide(AWS.ECRPublic.DescribeRegistriesHttp)`.

### Registry Access
**Example:** Look Up The Registry Alias
```typescript
// init — registry-level binding takes no resource
const describeRegistries = yield* AWS.ECRPublic.DescribeRegistries();

// runtime
const result = yield* describeRegistries();
const alias = result.registries?.[0]?.aliases?.[0]?.name;
```

@binding

## DescribeRegistries.Request

Request for {@link DescribeRegistries}.

## GetAuthorizationToken

Runtime binding for `ecr-public:GetAuthorizationToken` (plus the
`sts:GetServiceBearerToken` permission the API requires).

Retrieves a registry authorization token (valid for 12 hours) used to
authenticate `docker push` against `public.ecr.aws`. The token in the
response is `Redacted` — unwrap it with `Redacted.value` at the point of
use. Provide the implementation with
`Effect.provide(AWS.ECRPublic.GetAuthorizationTokenHttp)`.

### Registry Access
**Example:** Mint A Registry Auth Token
```typescript
// init — registry-level binding takes no resource
const getAuthorizationToken = yield* AWS.ECRPublic.GetAuthorizationToken();

// runtime
const result = yield* getAuthorizationToken();
const token = result.authorizationData?.authorizationToken; // Redacted<string>
```

@binding

## GetRegistryCatalogData

Runtime binding for `ecr-public:GetRegistryCatalogData`.

Reads the registry-level catalog metadata (the gallery display name).
Provide the implementation with
`Effect.provide(AWS.ECRPublic.GetRegistryCatalogDataHttp)`.

### Registry Access
**Example:** Read The Registry Display Name
```typescript
// init — registry-level binding takes no resource
const getRegistryCatalogData = yield* AWS.ECRPublic.GetRegistryCatalogData();

// runtime
const result = yield* getRegistryCatalogData();
const displayName = result.registryCatalogData.displayName;
```

@binding
