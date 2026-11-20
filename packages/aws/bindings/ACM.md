<!-- Docs for the generated AWS.ACM bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeCertificate

Runtime binding for `acm:DescribeCertificate`.

Bind this operation to a {@link Certificate} to get a callable that reads
the certificate's live metadata — status, domain validation state, renewal
summary, expiry — from inside a function runtime. Useful for expiry
monitors and issuance dashboards. Provide the implementation with
`Effect.provide(AWS.ACM.DescribeCertificateHttp)`.
### Inspecting Certificates
**Example:** Read a Certificate's Status and Expiry
```typescript
// init — bind the operation to the certificate
const describeCertificate = yield* AWS.ACM.DescribeCertificate(certificate);

// runtime
const { Certificate: detail } = yield* describeCertificate();
const status = detail?.Status;
const notAfter = detail?.NotAfter;
```

@binding

## ExportCertificate

Runtime binding for `acm:ExportCertificate`.

Bind this operation to a {@link Certificate} to get a callable that exports
the certificate, its chain, and the **encrypted private key**. Only
exportable certificates can be exported: private-CA certificates, or public
certificates requested with `export: "ENABLED"`. The returned `PrivateKey`
is sensitive and comes back wrapped in `Redacted` — unwrap it with
`Redacted.value` only at the point of use. Provide the implementation with
`Effect.provide(AWS.ACM.ExportCertificateHttp)`.
### Exporting Certificates
**Example:** Export a Certificate and Its Private Key
```typescript
// init — bind the operation to the certificate
const exportCertificate = yield* AWS.ACM.ExportCertificate(certificate);

// runtime — the passphrase encrypts the exported private key
const result = yield* exportCertificate({
  Passphrase: Redacted.make(new TextEncoder().encode(passphrase)),
});
const pem = result.Certificate;
const privateKeyPem =
  typeof result.PrivateKey === "string"
    ? result.PrivateKey
    : result.PrivateKey && Redacted.value(result.PrivateKey);
```

@binding

## ExportCertificate.Request

The export request without the injected `CertificateArn`.

`Passphrase` encrypts the exported private key and is sensitive — pass it
as `Redacted.make(new TextEncoder().encode(passphrase))` so it never leaks
into logs or traces.

## GetCertificate

Runtime binding for `acm:GetCertificate`.

Bind this operation to a {@link Certificate} to get a callable that
retrieves the issued certificate body and its certificate chain (both
PEM-encoded). The certificate must be issued — a certificate that is still
pending validation fails with the typed `RequestInProgressException`.
Provide the implementation with `Effect.provide(AWS.ACM.GetCertificateHttp)`.
### Reading Certificates
**Example:** Fetch the PEM Certificate Chain
```typescript
// init — bind the operation to the certificate
const getCertificate = yield* AWS.ACM.GetCertificate(certificate);

// runtime
const result = yield* getCertificate();
const pem = result.Certificate;
const chain = result.CertificateChain;
```

**Example:** Handle a Certificate That Is Not Issued Yet
```typescript
const pem = yield* getCertificate().pipe(
  Effect.map((result) => result.Certificate),
  Effect.catchTag("RequestInProgressException", () =>
    Effect.succeed(undefined),
  ),
);
```

@binding

## ImportCertificate

Runtime binding for `acm:ImportCertificate`.

An account-level operation (no certificate argument) that imports an
externally issued certificate into ACM in `us-east-1` — the classic
rotation flow where a function obtains a renewed certificate from an
outside CA and re-imports it over the existing ACM entry by passing its
`CertificateArn`. Provide the implementation with
`Effect.provide(AWS.ACM.ImportCertificateHttp)`.
### Importing Certificates
**Example:** Rotate an Externally Issued Certificate
```typescript
// init — account-level binding takes no resource
const importCertificate = yield* AWS.ACM.ImportCertificate();

// runtime — re-import a renewed certificate over the existing ARN
const encoder = new TextEncoder();
const result = yield* importCertificate({
  CertificateArn: existingArn,
  Certificate: encoder.encode(certificatePem),
  PrivateKey: Redacted.make(encoder.encode(privateKeyPem)),
  CertificateChain: encoder.encode(chainPem),
});
```

@binding

## ImportCertificate.Request

The full import request. `PrivateKey` is sensitive — pass it as
`Redacted.make(bytes)` so it never leaks into logs or traces. Pass
`CertificateArn` to re-import (rotate) an existing imported certificate;
omit it to import a new one.

## ListCertificates

Runtime binding for `acm:ListCertificates`.

An account-level operation (no certificate argument) that enumerates the
ACM certificates in `us-east-1` — the region where alchemy-managed
certificates live. Useful for expiry monitors that sweep every certificate
in the account. Note that the default filter only returns `RSA_2048`
certificates; pass `Includes.keyTypes` to widen it. Provide the
implementation with `Effect.provide(AWS.ACM.ListCertificatesHttp)`.
### Inspecting Certificates
**Example:** List Certificates Expiring Soon
```typescript
// init — account-level binding takes no resource
const listCertificates = yield* AWS.ACM.ListCertificates();

// runtime
const result = yield* listCertificates({
  CertificateStatuses: ["ISSUED"],
});
const expiring = (result.CertificateSummaryList ?? []).filter(
  (summary) =>
    summary.NotAfter !== undefined &&
    summary.NotAfter.getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000,
);
```

@binding

## RenewCertificate

Runtime binding for `acm:RenewCertificate`.

Bind this operation to a {@link Certificate} to get a callable that forces
managed renewal of an eligible certificate — typically an exported
certificate whose renewal is not fully automatic. Useful in rotation
functions that renew and then re-export a certificate. Provide the
implementation with `Effect.provide(AWS.ACM.RenewCertificateHttp)`.
### Renewing Certificates
**Example:** Force a Managed Renewal
```typescript
// init — bind the operation to the certificate
const renewCertificate = yield* AWS.ACM.RenewCertificate(certificate);

// runtime
yield* renewCertificate();
```

@binding

## ResendValidationEmail

Runtime binding for `acm:ResendValidationEmail`.

Bind this operation to a {@link Certificate} requested with
`validationMethod: "EMAIL"` to get a callable that re-sends the domain
ownership validation email — e.g. behind a "resend email" button in an
onboarding flow. Calling it on a DNS-validated certificate fails with the
typed `InvalidStateException`. Provide the implementation with
`Effect.provide(AWS.ACM.ResendValidationEmailHttp)`.
### Validating Certificates
**Example:** Re-send the Validation Email
```typescript
// init — bind the operation to the certificate
const resendValidationEmail =
  yield* AWS.ACM.ResendValidationEmail(certificate);

// runtime
yield* resendValidationEmail({
  Domain: "www.example.com",
  ValidationDomain: "example.com",
});
```

@binding

## ResendValidationEmail.Request

The resend request without the injected `CertificateArn`.

## RevokeCertificate

Runtime binding for `acm:RevokeCertificate`.

Bind this operation to a {@link Certificate} to get a callable that revokes
a previously exported public certificate — e.g. from a security-automation
function reacting to a leaked private key. Revocation is permanent. Provide
the implementation with `Effect.provide(AWS.ACM.RevokeCertificateHttp)`.
### Revoking Certificates
**Example:** Revoke a Compromised Certificate
```typescript
// init — bind the operation to the certificate
const revokeCertificate = yield* AWS.ACM.RevokeCertificate(certificate);

// runtime
yield* revokeCertificate({ RevocationReason: "KEY_COMPROMISE" });
```

@binding

## RevokeCertificate.Request

The revoke request without the injected `CertificateArn`.

## SearchCertificates

Runtime binding for `acm:SearchCertificates`.

An account-level operation (no certificate argument) that searches the ACM
certificates in `us-east-1` with richer filtering than
{@link ListCertificates} — X.509 attributes, status, type, and renewal
eligibility can be combined in a filter statement. Provide the
implementation with `Effect.provide(AWS.ACM.SearchCertificatesHttp)`.
### Inspecting Certificates
**Example:** Search Certificates by ARN
```typescript
// init — account-level binding takes no resource
const searchCertificates = yield* AWS.ACM.SearchCertificates();

// runtime
const result = yield* searchCertificates({
  FilterStatement: { Filter: { CertificateArn: certificateArn } },
});
const arns = (result.Results ?? []).map((r) => r.CertificateArn);
```

@binding
