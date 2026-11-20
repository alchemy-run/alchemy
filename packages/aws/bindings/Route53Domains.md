<!-- Docs for the generated AWS.Route53Domains bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CheckDomainAvailability

Runtime binding for `route53domains:CheckDomainAvailability` — check
whether a domain name is available for registration with Route 53.

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:CheckDomainAvailability` on `*`. Calls are pinned to
`us-east-1`, the only region that serves the Route 53 Domains API,
regardless of where the function runs.

Note that if the returned `Availability` is `PENDING` you must submit
another request to determine the availability of the domain name.
Provide the implementation with
`Effect.provide(AWS.Route53Domains.CheckDomainAvailabilityHttp)`.

### Checking Domain Availability
**Example:** Check Whether a Domain Can Be Registered
```typescript
// init
const checkDomainAvailability =
  yield* AWS.Route53Domains.CheckDomainAvailability();

// runtime
const result = yield* checkDomainAvailability({
  DomainName: "example-startup-name.com",
});
if (result.Availability === "AVAILABLE") {
  // domain can be registered
}
```

@binding

## CheckDomainTransferability

Runtime binding for `route53domains:CheckDomainTransferability` — check
whether a domain can be transferred to Amazon Route 53 from another
registrar.

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:CheckDomainTransferability` on `*`. Calls are pinned to
`us-east-1`, the only region that serves the Route 53 Domains API,
regardless of where the function runs.

Provide the implementation with
`Effect.provide(AWS.Route53Domains.CheckDomainTransferabilityHttp)`.

### Checking Domain Transferability
**Example:** Check Whether a Domain Can Be Transferred In
```typescript
// init
const checkDomainTransferability =
  yield* AWS.Route53Domains.CheckDomainTransferability();

// runtime
const result = yield* checkDomainTransferability({
  DomainName: "example.com",
});
if (result.Transferability?.Transferable === "TRANSFERABLE") {
  // domain can be transferred to Route 53
}
```

@binding

## GetDomainDetail

Runtime binding for `route53domains:GetDomainDetail` — return detailed
information (nameservers, contacts, expiry, DNSSEC keys, status list)
about a domain registered with the current AWS account.

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:GetDomainDetail` on `*`. Calls are pinned to `us-east-1`,
the only region that serves the Route 53 Domains API, regardless of where
the function runs.

Requesting detail for a domain that is not registered in the current
account fails with a typed `DomainNotFound` error. Provide the
implementation with
`Effect.provide(AWS.Route53Domains.GetDomainDetailHttp)`.

### Reading Domain Details
**Example:** Get the Nameservers of an Owned Domain
```typescript
// init
const getDomainDetail = yield* AWS.Route53Domains.GetDomainDetail();

// runtime
const detail = yield* getDomainDetail({ DomainName: "example.com" });
const nameservers = (detail.Nameservers ?? []).map((ns) => ns.Name);
```

**Example:** Handle a Domain That Is Not in the Account
```typescript
const detail = yield* getDomainDetail({ DomainName: "example.com" }).pipe(
  Effect.catchTag("DomainNotFound", () => Effect.succeed(undefined)),
);
```

@binding

## GetDomainSuggestions

Runtime binding for `route53domains:GetDomainSuggestions` — return a list
of suggested domain names based on a seed name, optionally restricted to
names that are currently available for registration.

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:GetDomainSuggestions` on `*`. Calls are pinned to
`us-east-1`, the only region that serves the Route 53 Domains API,
regardless of where the function runs.

Provide the implementation with
`Effect.provide(AWS.Route53Domains.GetDomainSuggestionsHttp)`.

### Suggesting Domain Names
**Example:** Suggest Available Alternatives for a Name
```typescript
// init
const getDomainSuggestions =
  yield* AWS.Route53Domains.GetDomainSuggestions();

// runtime
const result = yield* getDomainSuggestions({
  DomainName: "example.com",
  SuggestionCount: 10,
  OnlyAvailable: true,
});
const names = (result.SuggestionsList ?? []).map((s) => s.DomainName);
```

@binding

## GetOperationDetail

Runtime binding for `route53domains:GetOperationDetail` — return the
current status of an asynchronous Route 53 Domains operation (a domain
registration, renewal, transfer, or nameserver update identified by the
`OperationId` those calls return).

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:GetOperationDetail` on `*`. Calls are pinned to
`us-east-1`, the only region that serves the Route 53 Domains API,
regardless of where the function runs.

Provide the implementation with
`Effect.provide(AWS.Route53Domains.GetOperationDetailHttp)`.

### Tracking Registration Operations
**Example:** Poll a Registration Until It Completes
```typescript
// init
const getOperationDetail = yield* AWS.Route53Domains.GetOperationDetail();

// runtime
const detail = yield* getOperationDetail({ OperationId: operationId }).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("10 seconds"),
    until: (d) => d.Status === "SUCCESSFUL" || d.Status === "ERROR",
    times: 8,
  }),
);
```

@binding

## ListDomains

Runtime binding for `route53domains:ListDomains` — list all domain names
registered with Route 53 for the current AWS account.

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:ListDomains` on `*`. Calls are pinned to `us-east-1`, the
only region that serves the Route 53 Domains API, regardless of where the
function runs.

Pass `Marker` from a previous response's `NextPageMarker` to paginate.
Provide the implementation with
`Effect.provide(AWS.Route53Domains.ListDomainsHttp)`.

### Listing Registered Domains
**Example:** List the Account's Domains
```typescript
// init
const listDomains = yield* AWS.Route53Domains.ListDomains();

// runtime
const result = yield* listDomains({ MaxItems: 100 });
const names = (result.Domains ?? []).map((domain) => domain.DomainName);
```

@binding

## ListOperations

Runtime binding for `route53domains:ListOperations` — list the
asynchronous Route 53 Domains operations (registrations, renewals,
transfers, nameserver updates) performed on domains registered by the
current AWS account, optionally filtered by status, type, or submission
date.

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:ListOperations` on `*`. Calls are pinned to `us-east-1`,
the only region that serves the Route 53 Domains API, regardless of where
the function runs.

Provide the implementation with
`Effect.provide(AWS.Route53Domains.ListOperationsHttp)`.

### Tracking Registration Operations
**Example:** List In-Progress Operations
```typescript
// init
const listOperations = yield* AWS.Route53Domains.ListOperations();

// runtime
const result = yield* listOperations({
  Status: ["IN_PROGRESS"],
  MaxItems: 20,
});
const ids = (result.Operations ?? []).map((op) => op.OperationId);
```

@binding

## ListPrices

Runtime binding for `route53domains:ListPrices` — list registration,
transfer, renewal, restoration, and owner-change prices for the TLDs
supported by Route 53, or for one specific TLD.

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:ListPrices` on `*`. Calls are pinned to `us-east-1`, the
only region that serves the Route 53 Domains API, regardless of where the
function runs.

Provide the implementation with
`Effect.provide(AWS.Route53Domains.ListPricesHttp)`.

### Looking Up Prices
**Example:** Get the Registration Price for .com
```typescript
// init
const listPrices = yield* AWS.Route53Domains.ListPrices();

// runtime
const result = yield* listPrices({ Tld: "com" });
const price = result.Prices?.[0]?.RegistrationPrice?.Price;
```

@binding

## RegisterDomain

Runtime binding for `route53domains:RegisterDomain` — register a domain
name with Route 53 programmatically. Registration is asynchronous: the
response carries an `OperationId` you can poll with
`AWS.Route53Domains.GetOperationDetail`.

Registering a domain **bills the AWS account** for the registration fee,
so guard calls carefully (e.g. behind a
`AWS.Route53Domains.CheckDomainAvailability` check and explicit user
consent in a domain-reseller flow).

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:RegisterDomain` plus `route53:CreateHostedZone` (the API
pre-validates that the caller can create the hosted zone Route 53
auto-creates during registration) on `*`. Calls are pinned to
`us-east-1`, the only region that serves the Route 53 Domains API,
regardless of where the function runs.

Provide the implementation with
`Effect.provide(AWS.Route53Domains.RegisterDomainHttp)`.

### Registering Domains
**Example:** Register a Domain for a Customer
```typescript
// init
const registerDomain = yield* AWS.Route53Domains.RegisterDomain();

// runtime
const result = yield* registerDomain({
  DomainName: "example-customer-domain.com",
  DurationInYears: 1,
  AdminContact: contact,
  RegistrantContact: contact,
  TechContact: contact,
  AutoRenew: true,
});
// poll result.OperationId with GetOperationDetail until SUCCESSFUL
```

@binding

## RenewDomain

Runtime binding for `route53domains:RenewDomain` — renew a domain
registered in the current AWS account for the specified number of years.
Renewal is asynchronous: the response carries an `OperationId` you can
poll with `AWS.Route53Domains.GetOperationDetail`.

Renewing a domain **bills the AWS account** for the renewal fee, so guard
calls carefully. Renewing a domain that is not registered in the account
fails with a typed `DomainNotFound` error.

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:RenewDomain` on `*`. Calls are pinned to `us-east-1`, the
only region that serves the Route 53 Domains API, regardless of where the
function runs.

Provide the implementation with
`Effect.provide(AWS.Route53Domains.RenewDomainHttp)`.

### Renewing Domains
**Example:** Renew a Domain for One More Year
```typescript
// init
const renewDomain = yield* AWS.Route53Domains.RenewDomain();

// runtime
const result = yield* renewDomain({
  DomainName: "example.com",
  DurationInYears: 1,
  CurrentExpiryYear: 2027,
});
// poll result.OperationId with GetOperationDetail until SUCCESSFUL
```

@binding

## RetrieveDomainAuthCode

Runtime binding for `route53domains:RetrieveDomainAuthCode` — retrieve
the authorization (transfer) code for a domain registered in the current
AWS account. The code is required to transfer the domain to another
registrar.

The returned `AuthCode` is a secret and is typed as
`Redacted.Redacted<string>` — unwrap with `Redacted.value` only at the
point of use. Requesting the code for a domain that is not registered in
the account fails with a typed `DomainNotFound` error.

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:RetrieveDomainAuthCode` on `*`. Calls are pinned to
`us-east-1`, the only region that serves the Route 53 Domains API,
regardless of where the function runs.

Provide the implementation with
`Effect.provide(AWS.Route53Domains.RetrieveDomainAuthCodeHttp)`.

### Transferring Domains Out
**Example:** Retrieve the Transfer Authorization Code
```typescript
import * as Redacted from "effect/Redacted";

// init
const retrieveDomainAuthCode =
  yield* AWS.Route53Domains.RetrieveDomainAuthCode();

// runtime
const result = yield* retrieveDomainAuthCode({ DomainName: "example.com" });
const authCode =
  result.AuthCode !== undefined && typeof result.AuthCode !== "string"
    ? Redacted.value(result.AuthCode)
    : result.AuthCode;
```

@binding

## UpdateDomainNameservers

Runtime binding for `route53domains:UpdateDomainNameservers` — replace
the nameservers for a domain registered in the current AWS account (e.g.
point a registered domain at the delegation set of a Route 53 hosted
zone). The update is asynchronous: the response carries an `OperationId`
you can poll with `AWS.Route53Domains.GetOperationDetail`.

Updating nameservers for a domain that is not registered in the account
fails with a typed `DomainNotFound` error.

Route 53 Domains is a global registration API with no resource-level IAM:
the binding takes no arguments and grants the function
`route53domains:UpdateDomainNameservers` on `*`. Calls are pinned to
`us-east-1`, the only region that serves the Route 53 Domains API,
regardless of where the function runs.

Provide the implementation with
`Effect.provide(AWS.Route53Domains.UpdateDomainNameserversHttp)`.

### Updating Nameservers
**Example:** Point a Domain at a Hosted Zone's Delegation Set
```typescript
// init
const updateDomainNameservers =
  yield* AWS.Route53Domains.UpdateDomainNameservers();

// runtime
const result = yield* updateDomainNameservers({
  DomainName: "example.com",
  Nameservers: [
    { Name: "ns-1.awsdns-01.org" },
    { Name: "ns-2.awsdns-02.com" },
  ],
});
// poll result.OperationId with GetOperationDetail until SUCCESSFUL
```

@binding
