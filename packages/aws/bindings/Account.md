<!-- Docs for the generated AWS.Account bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetAccountInformation

Runtime binding for `account:GetAccountInformation`.

Reads the calling account's metadata — account id, account name, creation
date, and account state. Account Management is an account singleton, so the
binding takes no resource argument. Provide the implementation with
`Effect.provide(AWS.Account.GetAccountInformationHttp)`.
### Reading Account Settings
**Example:** Read the Account's Name and State
```typescript
// init — account-level binding, no resource argument
const getAccountInformation = yield* AWS.Account.GetAccountInformation();

// runtime
const info = yield* getAccountInformation();
console.log(info.AccountId, info.AccountState);
```

@binding

## GetAlternateContact

Runtime binding for `account:GetAlternateContact`.

Reads one of the calling account's alternate contacts (`BILLING`,
`OPERATIONS`, or `SECURITY`). When the requested contact type has never
been set, the operation fails with the typed
`ResourceNotFoundException`. Account Management is an account singleton,
so the binding takes no resource argument. Provide the implementation with
`Effect.provide(AWS.Account.GetAlternateContactHttp)`.
### Reading Account Settings
**Example:** Read the Billing Contact
```typescript
// init — account-level binding, no resource argument
const getAlternateContact = yield* AWS.Account.GetAlternateContact();

// runtime
const billing = yield* getAlternateContact({
  AlternateContactType: "BILLING",
}).pipe(
  Effect.catchTag("ResourceNotFoundException", () =>
    Effect.succeed({ AlternateContact: undefined }),
  ),
);
```

@binding

## GetContactInformation

Runtime binding for `account:GetContactInformation`.

Reads the calling account's primary contact — full name, address, phone
number, and company. The contact fields are marked sensitive at the wire
level, so distilled returns them as `string | Redacted<string>`. Account
Management is an account singleton, so the binding takes no resource
argument. Provide the implementation with
`Effect.provide(AWS.Account.GetContactInformationHttp)`.
### Reading Account Settings
**Example:** Read the Primary Contact
```typescript
// init — account-level binding, no resource argument
const getContactInformation = yield* AWS.Account.GetContactInformation();

// runtime
const { ContactInformation } = yield* getContactInformation();
console.log(ContactInformation?.CountryCode);
```

@binding

## GetRegionOptStatus

Runtime binding for `account:GetRegionOptStatus`.

Reads the opt-in status of a single Region for the calling account
(`ENABLED`, `DISABLED`, `ENABLING`, `DISABLING`, or
`ENABLED_BY_DEFAULT`). Account Management is an account singleton, so the
binding takes no resource argument. Provide the implementation with
`Effect.provide(AWS.Account.GetRegionOptStatusHttp)`.
### Reading Region Opt Status
**Example:** Check Whether an Opt-in Region Is Enabled
```typescript
// init — account-level binding, no resource argument
const getRegionOptStatus = yield* AWS.Account.GetRegionOptStatus();

// runtime
const status = yield* getRegionOptStatus({ RegionName: "ap-east-1" });
console.log(status.RegionOptStatus);
```

@binding

## ListRegions

Runtime binding for `account:ListRegions`.

Lists every Region available to the calling account together with its
opt-in status (`ENABLED`, `DISABLED`, `ENABLED_BY_DEFAULT`, …), optionally
filtered by `RegionOptStatusContains`. Account Management is an account
singleton, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Account.ListRegionsHttp)`.
### Reading Region Opt Status
**Example:** List the Enabled-by-Default Regions
```typescript
// init — account-level binding, no resource argument
const listRegions = yield* AWS.Account.ListRegions();

// runtime
const { Regions } = yield* listRegions({
  RegionOptStatusContains: ["ENABLED_BY_DEFAULT"],
});
for (const region of Regions ?? []) {
  console.log(region.RegionName, region.RegionOptStatus);
}
```

@binding
