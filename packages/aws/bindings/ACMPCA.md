<!-- Docs for the generated AWS.ACMPCA bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateCertificateAuthorityAuditReport

Runtime binding for `acm-pca:CreateCertificateAuthorityAuditReport`.

Bind a {@link CertificateAuthority} inside a function runtime to generate
an audit report of every private-key use (issue/revoke) into an S3
bucket — e.g. from a scheduled compliance function. AWS allows at most
one report per CA every 30 minutes. The S3 bucket policy must grant
Amazon Web Services Private CA write access. Provide
`ACMPCA.CreateCertificateAuthorityAuditReportHttp` on the Function effect
to implement the binding.

### Audit Reports
**Example:** Generate an Audit Report
```typescript
// init
const createAuditReport =
  yield* ACMPCA.CreateCertificateAuthorityAuditReport(ca);

// runtime
const report = yield* createAuditReport({
  S3BucketName: bucketName,
  AuditReportResponseFormat: "JSON",
});
// report.AuditReportId / report.S3Key
```

@binding

## DescribeCertificateAuthorityAuditReport

Runtime binding for `acm-pca:DescribeCertificateAuthorityAuditReport`.

Bind a {@link CertificateAuthority} inside a function runtime to check
the status of an audit report started with
{@link CreateCertificateAuthorityAuditReport} (reports are generated
asynchronously into S3). Provide
`ACMPCA.DescribeCertificateAuthorityAuditReportHttp` on the Function
effect to implement the binding.

### Audit Reports
**Example:** Poll an Audit Report Until It Succeeds
```typescript
// init
const describeAuditReport =
  yield* ACMPCA.DescribeCertificateAuthorityAuditReport(ca);

// runtime
const status = yield* describeAuditReport({
  AuditReportId: report.AuditReportId!,
}).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("2 seconds"),
    until: (r) => r.AuditReportStatus !== "CREATING",
    times: 10,
  }),
);
```

@binding

## GetCertificate

Runtime binding for `acm-pca:GetCertificate`.

Bind a {@link CertificateAuthority} inside a function runtime to retrieve
a certificate previously issued by the CA (via the
{@link IssueCertificate} binding). Issuance is asynchronous — retry while
the typed `RequestInProgressException` is observed. Provide
`ACMPCA.GetCertificateHttp` on the Function effect to implement the
binding.

### Retrieving Issued Certificates
**Example:** Poll for an Issued Certificate
```typescript
// init
const getCertificate = yield* ACMPCA.GetCertificate(ca);

// runtime
const certificate = yield* getCertificate({
  CertificateArn: issued.CertificateArn!,
}).pipe(
  Effect.retry({
    while: (e) => e._tag === "RequestInProgressException",
    schedule: Schedule.exponential("500 millis"),
    times: 8,
  }),
);
// certificate.Certificate / certificate.CertificateChain (PEM)
```

@binding

## GetCertificateAuthorityCertificate

Runtime binding for `acm-pca:GetCertificateAuthorityCertificate`.

Bind a {@link CertificateAuthority} inside a function runtime to retrieve
the CA's own certificate and chain (PEM) — e.g. to build a trust store
for mutual-TLS verification of certificates the CA issued. Provide
`ACMPCA.GetCertificateAuthorityCertificateHttp` on the Function effect to
implement the binding.

### Reading the CA Certificate
**Example:** Build a Trust Store
```typescript
// init
const getCaCertificate =
  yield* ACMPCA.GetCertificateAuthorityCertificate(ca);

// runtime
const { Certificate, CertificateChain } = yield* getCaCertificate();
```

@binding

## GetCertificateAuthorityCsr

Runtime binding for `acm-pca:GetCertificateAuthorityCsr`.

Bind a {@link CertificateAuthority} inside a function runtime to retrieve
the CSR the CA generated at creation. The CSR is the input to the CA
activation flow: sign it (self-sign a root via
{@link IssueCertificate}, or have an external parent CA sign it), then
install the result with {@link ImportCertificateAuthorityCertificate}.
Provide `ACMPCA.GetCertificateAuthorityCsrHttp` on the Function effect to
implement the binding.

### CA Activation
**Example:** Fetch the CA's CSR
```typescript
// init
const getCsr = yield* ACMPCA.GetCertificateAuthorityCsr(ca);

// runtime
const { Csr } = yield* getCsr();
```

@binding

## ImportCertificateAuthorityCertificate

Runtime binding for `acm-pca:ImportCertificateAuthorityCertificate`.

Bind a {@link CertificateAuthority} inside a function runtime to install
the CA's signed certificate — the final step of the activation flow
(fetch CSR via {@link GetCertificateAuthorityCsr}, sign it, import). This
enables workflows where the CA's CSR is signed by an on-premises or
external parent CA at runtime. Provide
`ACMPCA.ImportCertificateAuthorityCertificateHttp` on the Function effect
to implement the binding.

### CA Activation
**Example:** Install a Signed CA Certificate
```typescript
// init
const importCaCertificate =
  yield* ACMPCA.ImportCertificateAuthorityCertificate(ca);

// runtime
yield* importCaCertificate({
  Certificate: new TextEncoder().encode(signedCertPem),
  CertificateChain: new TextEncoder().encode(chainPem),
});
```

@binding

## IssueCertificate

Runtime binding for `acm-pca:IssueCertificate`.

Bind a {@link CertificateAuthority} inside a function runtime to sign
certificate signing requests (CSRs) with the CA's private key. Returns
the ARN of the issued certificate — retrieve the PEM with the
{@link GetCertificate} binding (issuance is asynchronous, so poll while
`RequestInProgressException` is observed). Provide
`ACMPCA.IssueCertificateHttp` on the Function effect to implement the
binding.

### Issuing Certificates
**Example:** Sign a CSR
```typescript
// init
const issueCertificate = yield* ACMPCA.IssueCertificate(ca);

// runtime
const issued = yield* issueCertificate({
  Csr: new TextEncoder().encode(csrPem),
  SigningAlgorithm: "SHA256WITHRSA",
  Validity: { Type: "DAYS", Value: 7 },
});
// issued.CertificateArn
```

@binding

## RevokeCertificate

Runtime binding for `acm-pca:RevokeCertificate`.

Bind a {@link CertificateAuthority} inside a function runtime to revoke
certificates the CA issued (e.g. on credential compromise). Revoked
certificates appear in the CA's CRL/OCSP responses when revocation is
configured. The serial number is the hex serial from the issued
certificate. Provide `ACMPCA.RevokeCertificateHttp` on the Function
effect to implement the binding.

### Revoking Certificates
**Example:** Revoke a Compromised Certificate
```typescript
// init
const revokeCertificate = yield* ACMPCA.RevokeCertificate(ca);

// runtime
yield* revokeCertificate({
  CertificateSerial: serialHex,
  RevocationReason: "KEY_COMPROMISE",
});
```

@binding
