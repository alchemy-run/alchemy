<!-- Docs for the generated AWS.Signer bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeSigningJob

Runtime binding for `signer:DescribeSigningJob`.

Reads a signing job by the `jobId` returned from `StartSigningJob` /
`SignPayload` — its status (`InProgress`, `Succeeded`, `Failed`), the
signed object's S3 location, and the signature expiry. Account-level
operation — job ids are chosen per request at runtime, so the binding takes
no resource argument. Provide the implementation with
`Effect.provide(AWS.Signer.DescribeSigningJobHttp)`.
### Observing Signing Jobs
**Example:** Wait for a Job to Finish
```typescript
// init — account-level binding, no resource argument
const describeSigningJob = yield* AWS.Signer.DescribeSigningJob();

// runtime
const job = yield* describeSigningJob({ jobId });
const signedKey = job.signedObject?.s3?.key;
```

@binding

## GetRevocationStatus

Runtime binding for `signer:GetRevocationStatus`.

Checks whether a signature's signing profile version, signing job, or
signing certificates have been revoked — the verification-time complement
to `RevokeSignature` / `RevokeSigningProfile`, served from Signer's
regional verification (`data-`) endpoint. Account-level operation — the
entities checked are chosen per request at runtime, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.Signer.GetRevocationStatusHttp)`.
### Revoking Signatures
**Example:** Verify a Signature Before Trusting It
```typescript
// init — account-level binding, no resource argument
const getRevocationStatus = yield* AWS.Signer.GetRevocationStatus();

// runtime
const { revokedEntities } = yield* getRevocationStatus({
  signatureTimestamp: signedAt,
  platformId: "Notation-OCI-SHA384-ECDSA",
  profileVersionArn,
  jobArn,
  certificateHashes,
});
const trusted = (revokedEntities ?? []).length === 0;
```

@binding

## GetSigningPlatform

Runtime binding for `signer:GetSigningPlatform`.

Reads one AWS-managed signing platform by id — its signing configuration
(encryption/hash algorithms), image format, size limit, and whether it
supports revocation. Account-level operation over the AWS-managed platform
catalog, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Signer.GetSigningPlatformHttp)`.
### Discovering Platforms
**Example:** Check Revocation Support
```typescript
// init — account-level binding, no resource argument
const getSigningPlatform = yield* AWS.Signer.GetSigningPlatform();

// runtime
const platform = yield* getSigningPlatform({
  platformId: "AWSLambda-SHA384-ECDSA",
});
const canRevoke = platform.revocationSupported === true;
```

@binding

## ListSigningJobs

Runtime binding for `signer:ListSigningJobs`.

Lists the account's signing jobs, filterable by status, platform,
requester, revocation state, and signature expiry window. Account-level
operation — the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Signer.ListSigningJobsHttp)`.
### Observing Signing Jobs
**Example:** List In-Progress Jobs
```typescript
// init — account-level binding, no resource argument
const listSigningJobs = yield* AWS.Signer.ListSigningJobs();

// runtime
const { jobs } = yield* listSigningJobs({ status: "InProgress" });
```

@binding

## ListSigningPlatforms

Runtime binding for `signer:ListSigningPlatforms`.

Lists the AWS-managed signing platforms (Lambda, Notation/OCI, IoT,
FreeRTOS, …), filterable by category, partner, and target. Account-level
operation over the AWS-managed platform catalog, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.Signer.ListSigningPlatformsHttp)`.
### Discovering Platforms
**Example:** Enumerate Available Platforms
```typescript
// init — account-level binding, no resource argument
const listSigningPlatforms = yield* AWS.Signer.ListSigningPlatforms();

// runtime
const { platforms } = yield* listSigningPlatforms();
const ids = (platforms ?? []).map((p) => p.platformId);
```

@binding

## RevokeSignature

Runtime binding for `signer:RevokeSignature`.

Permanently invalidates the signature produced by a single signing job —
the surgical alternative to revoking a whole profile version when one
artifact is compromised. Account-level operation — job ids are chosen per
request at runtime, so the binding takes no resource argument. Provide the
implementation with `Effect.provide(AWS.Signer.RevokeSignatureHttp)`.
### Revoking Signatures
**Example:** Revoke One Job's Signature
```typescript
// init — account-level binding, no resource argument
const revokeSignature = yield* AWS.Signer.RevokeSignature();

// runtime
yield* revokeSignature({ jobId, reason: "artifact compromised" });
```

@binding

## RevokeSigningProfile

Runtime binding for `signer:RevokeSigningProfile`.

Revokes a version of the bound {@link SigningProfile}, permanently
invalidating every signature that version produced on or after
`effectiveTime` — the incident-response lever when signing material is
compromised. Revocation is irreversible. The profile name is injected from
the binding; pass the `profileVersion` to revoke. Provide the
implementation with `Effect.provide(AWS.Signer.RevokeSigningProfileHttp)`.
### Revoking Signatures
**Example:** Revoke a Compromised Profile Version
```typescript
// init — bind the operation to the profile
const revokeSigningProfile = yield* AWS.Signer.RevokeSigningProfile(profile);

// runtime — invalidate everything the version signed from now on
yield* revokeSigningProfile({
  profileVersion,
  reason: "signing key compromised",
  effectiveTime: new Date(),
});
```

@binding

## SignPayload

Runtime binding for `signer:SignPayload`.

Signs a binary payload synchronously with the bound {@link SigningProfile}
and returns the signature inline — the API behind Notation container-image
signing (use a `Notation-OCI-SHA384-ECDSA` profile). The profile name is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.Signer.SignPayloadHttp)`.
### Signing Code
**Example:** Sign a Notation Payload
```typescript
// init — bind the operation to the Notation profile
const signPayload = yield* AWS.Signer.SignPayload(profile);

// runtime
const { jobId, signature } = yield* signPayload({
  payload: new TextEncoder().encode(JSON.stringify(notaryPayload)),
  payloadFormat: "application/vnd.cncf.notary.payload.v1+json",
});
```

@binding

## StartSigningJob

Runtime binding for `signer:StartSigningJob`.

Starts an asynchronous code-signing job with the bound
{@link SigningProfile} — Signer reads the (versioned) source object from
S3, signs it with the profile's platform and material, and writes the
signed artifact to the destination bucket. The profile name is injected
from the binding; the caller's credentials are used for the S3 access, so
also bind `S3.GetObject` on the source bucket and `S3.PutObject` on the
destination. Returns the `jobId` for use with `DescribeSigningJob` /
`RevokeSignature`. Provide the implementation with
`Effect.provide(AWS.Signer.StartSigningJobHttp)`.
### Signing Code
**Example:** Sign an S3 Object
```typescript
// init — bind the operation to the profile
const startSigningJob = yield* AWS.Signer.StartSigningJob(profile);

// runtime
const { jobId } = yield* startSigningJob({
  source: { s3: { bucketName: "src", key: "code.zip", version: versionId } },
  destination: { s3: { bucketName: "dst", prefix: "signed/" } },
});
```

@binding
