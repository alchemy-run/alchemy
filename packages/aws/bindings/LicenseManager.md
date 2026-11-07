<!-- Docs for the generated AWS.LicenseManager bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AcceptGrant

Runtime binding for `license-manager:AcceptGrant` — accept a license
grant that another account distributed to this account, activating the
granted entitlements.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.AcceptGrantHttp)`.
### Managing Grants
**Example:** Accept a Received Grant
```typescript
// init
const acceptGrant = yield* AWS.LicenseManager.AcceptGrant();

// runtime
const { Status } = yield* acceptGrant({ GrantArn: grantArn });
```

@binding

## AcceptGrant.Request

Request for {@link AcceptGrant}.

## CheckInLicense

Runtime binding for `license-manager:CheckInLicense` — return a
previously checked-out entitlement to the license pool using the
consumption token from {@link CheckoutLicense}.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.CheckInLicenseHttp)`.
### License Checkout Data Plane
**Example:** Check an Entitlement Back In
```typescript
// init
const checkInLicense = yield* AWS.LicenseManager.CheckInLicense();

// runtime
yield* checkInLicense({ LicenseConsumptionToken: token });
```

@binding

## CheckInLicense.Request

Request for {@link CheckInLicense}.

## CheckoutBorrowLicense

Runtime binding for `license-manager:CheckoutBorrowLicense` — check out
an offline-capable (borrow) entitlement from a seller-issued license
that allows borrowing. The signed token proves the entitlement while the
consumer is disconnected.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.CheckoutBorrowLicenseHttp)`.
### License Checkout Data Plane
**Example:** Borrow an Entitlement for Offline Use
```typescript
// init
const checkoutBorrow = yield* AWS.LicenseManager.CheckoutBorrowLicense();

// runtime
const borrowed = yield* checkoutBorrow({
  LicenseArn: licenseArn,
  Entitlements: [{ Name: "seats", Value: "1", Unit: "Count" }],
  DigitalSignatureMethod: "JWT_PS384",
  ClientToken: crypto.randomUUID(),
});
```

@binding

## CheckoutBorrowLicense.Request

Request for {@link CheckoutBorrowLicense}.

## CheckoutLicense

Runtime binding for `license-manager:CheckoutLicense` — check out
entitlements from a seller-issued license for the calling application.
The returned `LicenseConsumptionToken` is used to check in or extend the
consumption; `PROVISIONAL` checkouts expire and must be extended with
{@link ExtendLicenseConsumption}.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.CheckoutLicenseHttp)`.
### License Checkout Data Plane
**Example:** Check Out an Entitlement
```typescript
// init — account-level binding takes no resource
const checkoutLicense = yield* AWS.LicenseManager.CheckoutLicense();

// runtime
const checkout = yield* checkoutLicense({
  ProductSKU: "my-product-sku",
  CheckoutType: "PROVISIONAL",
  KeyFingerprint: keyFingerprint,
  Entitlements: [{ Name: "seats", Value: "1", Unit: "Count" }],
  ClientToken: crypto.randomUUID(),
});
const token = checkout.LicenseConsumptionToken;
// on the Function effect:
// .pipe(Effect.provide(AWS.LicenseManager.CheckoutLicenseHttp))
```

@binding

## CheckoutLicense.Request

Request for {@link CheckoutLicense}.

## CreateGrant

Runtime binding for `license-manager:CreateGrant` — share a seller-issued
license's entitlements with an Amazon Web Services account, organization,
or organizational unit. The distribution half of an ISV fulfillment
backend: after minting a license with `CreateLicense`, grant it to the
customer's account.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.CreateGrantHttp)`.
### Managing Grants
**Example:** Grant a License to a Customer Account
```typescript
// init
const createGrant = yield* AWS.LicenseManager.CreateGrant();

// runtime
const { GrantArn } = yield* createGrant({
  GrantName: "customer-grant",
  LicenseArn: licenseArn,
  HomeRegion: region,
  Principals: [`arn:aws:iam::${customerAccountId}:root`],
  AllowedOperations: ["CheckoutLicense", "CheckInLicense", "ExtendConsumptionLicense", "ListPurchasedLicenses"],
  ClientToken: crypto.randomUUID(),
});
```

@binding

## CreateGrant.Request

Request for {@link CreateGrant}.

## CreateGrantVersion

Runtime binding for `license-manager:CreateGrantVersion` — publish a new
version of an existing grant. This is also how a recipient **activates**
an accepted grant: create a version with `Status: "ACTIVE"` (and how a
grantor amends allowed operations or deactivates a grant).

Provide the implementation with
`Effect.provide(AWS.LicenseManager.CreateGrantVersionHttp)`.
### Managing Grants
**Example:** Activate an Accepted Grant
```typescript
// init
const createGrantVersion = yield* AWS.LicenseManager.CreateGrantVersion();

// runtime — after acceptGrant({ GrantArn })
yield* createGrantVersion({
  GrantArn: grantArn,
  Status: "ACTIVE",
  ClientToken: crypto.randomUUID(),
});
```

@binding

## CreateGrantVersion.Request

Request for {@link CreateGrantVersion}.

## CreateLicense

Runtime binding for `license-manager:CreateLicense` — issue a
seller-issued license from the calling application. The core of an ISV
ordering/fulfillment backend: when a customer purchases, the backend
mints a license with the product SKU, entitlements, validity window,
and consumption configuration, then distributes it via grants or
activation tokens.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.CreateLicenseHttp)`.
### Issuing Licenses
**Example:** Issue a License on Purchase
```typescript
// init — account-level binding takes no resource
const createLicense = yield* AWS.LicenseManager.CreateLicense();

// runtime
const { LicenseArn, Version } = yield* createLicense({
  LicenseName: "my-product-license",
  ProductName: "My Product",
  ProductSKU: "my-product-sku",
  Issuer: { Name: "my-company" },
  HomeRegion: region,
  Validity: { Begin: new Date().toISOString() },
  Entitlements: [
    { Name: "seats", MaxCount: 10, Unit: "Count", AllowCheckIn: true },
  ],
  Beneficiary: customerAccountId,
  ConsumptionConfiguration: {
    ProvisionalConfiguration: { MaxTimeToLiveInMinutes: 60 },
  },
  ClientToken: crypto.randomUUID(),
});
```

@binding

## CreateLicense.Request

Request for {@link CreateLicense}.

## CreateLicenseVersion

Runtime binding for `license-manager:CreateLicenseVersion` — publish a new
version of an existing seller-issued license (changed entitlements,
extended validity, a status flip to `AVAILABLE`/`DEACTIVATED`). Pass the
current version as `SourceVersion`.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.CreateLicenseVersionHttp)`.
### Issuing Licenses
**Example:** Extend a License's Validity
```typescript
// init
const createLicenseVersion = yield* AWS.LicenseManager.CreateLicenseVersion();

// runtime — read the current definition, publish an amended version
const { License } = yield* getLicense({ LicenseArn: licenseArn });
yield* createLicenseVersion({
  LicenseArn: licenseArn,
  LicenseName: License!.LicenseName!,
  ProductName: License!.ProductName!,
  Issuer: { Name: License!.Issuer!.Name! },
  HomeRegion: License!.HomeRegion!,
  Validity: { Begin: License!.Validity!.Begin, End: newEnd },
  Entitlements: License!.Entitlements!,
  ConsumptionConfiguration: License!.ConsumptionConfiguration!,
  Status: "AVAILABLE",
  SourceVersion: License!.Version,
  ClientToken: crypto.randomUUID(),
});
```

@binding

## CreateLicenseVersion.Request

Request for {@link CreateLicenseVersion}.

## CreateToken

Runtime binding for `license-manager:CreateToken` — mint a long-lived
refresh token for a license. The token (a claims-based JWT, `Redacted`
end-to-end) is distributed to license consumers, who exchange it for
temporary credentials with `GetAccessToken` +
`AssumeRoleWithWebIdentity`.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.CreateTokenHttp)`.
### License Checkout Data Plane
**Example:** Mint an Activation Token for a License
```typescript
// init
const createToken = yield* AWS.LicenseManager.CreateToken();

// runtime — Token is Redacted; hand it to the consumer without logging it
const { TokenId, Token } = yield* createToken({
  LicenseArn: licenseArn,
  ClientToken: crypto.randomUUID(),
});
```

@binding

## CreateToken.Request

Request for {@link CreateToken}.

## DeleteGrant

Runtime binding for `license-manager:DeleteGrant` — retire a grant (e.g.
when a customer's subscription lapses). The grant's current version must
be passed as `Version`.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.DeleteGrantHttp)`.
### Managing Grants
**Example:** Delete a Grant
```typescript
// init
const deleteGrant = yield* AWS.LicenseManager.DeleteGrant();

// runtime
const { Grant } = yield* getGrant({ GrantArn: grantArn });
yield* deleteGrant({ GrantArn: grantArn, Version: Grant!.Version! });
```

@binding

## DeleteGrant.Request

Request for {@link DeleteGrant}.

## DeleteLicense

Runtime binding for `license-manager:DeleteLicense` — delete a
seller-issued license (e.g. on refund or subscription cancellation). The
license's current version must be passed as `SourceVersion`.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.DeleteLicenseHttp)`.
### Issuing Licenses
**Example:** Delete a License on Cancellation
```typescript
// init
const deleteLicense = yield* AWS.LicenseManager.DeleteLicense();

// runtime
const { License } = yield* getLicense({ LicenseArn: licenseArn });
yield* deleteLicense({
  LicenseArn: licenseArn,
  SourceVersion: License!.Version!,
});
```

@binding

## DeleteLicense.Request

Request for {@link DeleteLicense}.

## DeleteToken

Runtime binding for `license-manager:DeleteToken` — revoke a refresh
token minted by `CreateToken`, cutting off further `GetAccessToken`
exchanges for it.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.DeleteTokenHttp)`.
### License Checkout Data Plane
**Example:** Revoke an Activation Token
```typescript
// init
const deleteToken = yield* AWS.LicenseManager.DeleteToken();

// runtime
yield* deleteToken({ TokenId: tokenId });
```

@binding

## DeleteToken.Request

Request for {@link DeleteToken}.

## ExtendLicenseConsumption

Runtime binding for `license-manager:ExtendLicenseConsumption` — extend
a `PROVISIONAL` checkout's expiration before it lapses, keeping a
long-running consumer's entitlement active.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.ExtendLicenseConsumptionHttp)`.
### License Checkout Data Plane
**Example:** Extend a Provisional Checkout
```typescript
// init
const extendConsumption =
  yield* AWS.LicenseManager.ExtendLicenseConsumption();

// runtime
const { Expiration } = yield* extendConsumption({
  LicenseConsumptionToken: token,
});
```

@binding

## ExtendLicenseConsumption.Request

Request for {@link ExtendLicenseConsumption}.

## GetAccessToken

Runtime binding for `license-manager:GetAccessToken` — exchange a
long-lived refresh token (minted by `CreateToken`) for a temporary
access token to use with `AssumeRoleWithWebIdentity`. Both the refresh
token and the returned access token are `Redacted` end-to-end.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.GetAccessTokenHttp)`.
### License Checkout Data Plane
**Example:** Exchange a Refresh Token for an Access Token
```typescript
// init
const getAccessToken = yield* AWS.LicenseManager.GetAccessToken();

// runtime — AccessToken is Redacted; unwrap only at the point of use
const { AccessToken } = yield* getAccessToken({ Token: refreshToken });
```

@binding

## GetAccessToken.Request

Request for {@link GetAccessToken}.

## GetGrant

Runtime binding for `license-manager:GetGrant` — read a license grant's
details (grantee, allowed operations, status) by ARN.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.GetGrantHttp)`.
### Reading Licenses and Grants
**Example:** Read a Grant
```typescript
// init
const getGrant = yield* AWS.LicenseManager.GetGrant();

// runtime
const { Grant } = yield* getGrant({ GrantArn: grantArn });
```

@binding

## GetGrant.Request

Request for {@link GetGrant}.

## GetLicense

Runtime binding for `license-manager:GetLicense` — read a seller-issued
license's details (issuer, entitlements, validity, consumption
configuration) by ARN.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.GetLicenseHttp)`.
### Reading Licenses and Grants
**Example:** Read a License
```typescript
// init
const getLicense = yield* AWS.LicenseManager.GetLicense();

// runtime
const { License } = yield* getLicense({ LicenseArn: licenseArn });
```

@binding

## GetLicense.Request

Request for {@link GetLicense}.

## GetLicenseConfiguration

Runtime binding for `license-manager:GetLicenseConfiguration` — read the
bound license configuration's live state (counting type, license count,
consumed count, rules, status) from a deployed Lambda or Task.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.GetLicenseConfigurationHttp)`.
### Reading License Configurations
**Example:** Read the Bound Configuration's Consumption
```typescript
// init
const getConfiguration =
  yield* AWS.LicenseManager.GetLicenseConfiguration(licenses);

// runtime
const config = yield* getConfiguration();
const remaining =
  (config.LicenseCount ?? 0) - (config.ConsumedLicenses ?? 0);
// on the Function effect:
// .pipe(Effect.provide(AWS.LicenseManager.GetLicenseConfigurationHttp))
```

@binding

## GetLicenseUsage

Runtime binding for `license-manager:GetLicenseUsage` — read the
per-entitlement usage counters of a seller-issued license.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.GetLicenseUsageHttp)`.
### Reading Licenses and Grants
**Example:** Read a License's Entitlement Usage
```typescript
// init
const getLicenseUsage = yield* AWS.LicenseManager.GetLicenseUsage();

// runtime
const { LicenseUsage } = yield* getLicenseUsage({
  LicenseArn: licenseArn,
});
```

@binding

## GetLicenseUsage.Request

Request for {@link GetLicenseUsage}.

## GetServiceSettings

Runtime binding for `license-manager:GetServiceSettings` — read the
account's License Manager settings (S3 report bucket, SNS alert topic,
organization integration).

Provide the implementation with
`Effect.provide(AWS.LicenseManager.GetServiceSettingsHttp)`.
### Resource Inventory and Specifications
**Example:** Read the Account's Service Settings
```typescript
// init
const getServiceSettings =
  yield* AWS.LicenseManager.GetServiceSettings();

// runtime
const { SnsTopicArn, EnableCrossAccountsDiscovery } =
  yield* getServiceSettings();
```

@binding

## GetServiceSettings.Request

Request for {@link GetServiceSettings}.

## ListDistributedGrants

Runtime binding for `license-manager:ListDistributedGrants` — list the
grants this account has distributed to other accounts.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.ListDistributedGrantsHttp)`.
### Managing Grants
**Example:** List Distributed Grants
```typescript
// init
const listDistributedGrants =
  yield* AWS.LicenseManager.ListDistributedGrants();

// runtime
const { Grants } = yield* listDistributedGrants();
```

@binding

## ListDistributedGrants.Request

Request for {@link ListDistributedGrants}.

## ListLicenseVersions

Runtime binding for `license-manager:ListLicenseVersions` — list all
versions of a seller-issued license.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.ListLicenseVersionsHttp)`.
### Reading Licenses and Grants
**Example:** List a License's Versions
```typescript
// init
const listVersions = yield* AWS.LicenseManager.ListLicenseVersions();

// runtime
const { Licenses } = yield* listVersions({ LicenseArn: licenseArn });
```

@binding

## ListLicenseVersions.Request

Request for {@link ListLicenseVersions}.

## ListLicenses

Runtime binding for `license-manager:ListLicenses` — list the
seller-issued licenses owned by the account.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.ListLicensesHttp)`.
### Reading Licenses and Grants
**Example:** List Owned Licenses
```typescript
// init
const listLicenses = yield* AWS.LicenseManager.ListLicenses();

// runtime
const { Licenses } = yield* listLicenses();
```

@binding

## ListLicenses.Request

Request for {@link ListLicenses}.

## ListReceivedGrants

Runtime binding for `license-manager:ListReceivedGrants` — list the
grants distributed to this account, e.g. to find pending grants to
{@link AcceptGrant}.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.ListReceivedGrantsHttp)`.
### Managing Grants
**Example:** List Received Grants
```typescript
// init
const listReceivedGrants =
  yield* AWS.LicenseManager.ListReceivedGrants();

// runtime
const { Grants } = yield* listReceivedGrants();
```

@binding

## ListReceivedGrants.Request

Request for {@link ListReceivedGrants}.

## ListReceivedLicenses

Runtime binding for `license-manager:ListReceivedLicenses` — list the
licenses granted to the account (e.g. AWS Marketplace entitlements),
the consumer-side counterpart of {@link ListLicenses}.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.ListReceivedLicensesHttp)`.
### Reading Licenses and Grants
**Example:** List Received Licenses
```typescript
// init
const listReceived = yield* AWS.LicenseManager.ListReceivedLicenses();

// runtime
const { Licenses } = yield* listReceived();
```

@binding

## ListReceivedLicenses.Request

Request for {@link ListReceivedLicenses}.

## ListResourceInventory

Runtime binding for `license-manager:ListResourceInventory` — list the
resource inventory (instances and their platform details) discovered by
License Manager via Systems Manager inventory.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.ListResourceInventoryHttp)`.
### Resource Inventory and Specifications
**Example:** List Discovered Resources
```typescript
// init
const listInventory = yield* AWS.LicenseManager.ListResourceInventory();

// runtime
const { ResourceInventoryList } = yield* listInventory();
```

@binding

## ListResourceInventory.Request

Request for {@link ListResourceInventory}.

## ListTokens

Runtime binding for `license-manager:ListTokens` — enumerate the refresh
tokens minted for the account's licenses (token metadata only; the token
material itself is returned once by `CreateToken`).

Provide the implementation with
`Effect.provide(AWS.LicenseManager.ListTokensHttp)`.
### License Checkout Data Plane
**Example:** List Activation Tokens
```typescript
// init
const listTokens = yield* AWS.LicenseManager.ListTokens();

// runtime
const { Tokens } = yield* listTokens();
```

@binding

## ListTokens.Request

Request for {@link ListTokens}.

## ListUsageForLicenseConfiguration

Runtime binding for `license-manager:ListUsageForLicenseConfiguration` —
list per-resource license usage (consumed licenses per instance/AMI)
tracked by the bound license configuration.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.ListUsageForLicenseConfigurationHttp)`.
### Reading License Configurations
**Example:** List Per-Resource License Usage
```typescript
// init
const listUsage =
  yield* AWS.LicenseManager.ListUsageForLicenseConfiguration(licenses);

// runtime
const { LicenseConfigurationUsageList } = yield* listUsage();
```

@binding

## ListUsageForLicenseConfiguration.Request

Request for {@link ListUsageForLicenseConfiguration}. The bound configuration's ARN is injected
automatically.

## RejectGrant

Runtime binding for `license-manager:RejectGrant` — reject a license
grant that another account distributed to this account.

Provide the implementation with
`Effect.provide(AWS.LicenseManager.RejectGrantHttp)`.
### Managing Grants
**Example:** Reject a Received Grant
```typescript
// init
const rejectGrant = yield* AWS.LicenseManager.RejectGrant();

// runtime
const { Status } = yield* rejectGrant({ GrantArn: grantArn });
```

@binding

## RejectGrant.Request

Request for {@link RejectGrant}.
