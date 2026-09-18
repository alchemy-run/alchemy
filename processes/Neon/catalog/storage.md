# Neon.Bucket and Neon.Object<T>

Initial status: **missing** for both resources. Gate set: G0–G5, G9–G10. Management operations already exist in the Neon SDK except bucket visibility mutation; S3 data-plane operations use the existing S3 transport against Neon's path-style endpoint, not AWS infrastructure/IAM.

## Files

`packages/alchemy/src/Neon/{Bucket,Object}.ts`, internal storage transport helpers, minimal Neon Providers/index registration; tests `packages/alchemy/test/Neon/{Bucket,Object}.test.ts` plus owned native/Effect fixtures. Binding contracts and layers are cataloged separately in `bindings.md`.

## Bucket contract

| Prop | Type/default | Mutation/identity rule |
| --- | --- | --- |
| branch or project | exclusive shared scope | Project/branch changes replace. Never implicitly own the parent. |
| name | optional string; deterministic 3–63 character S3-compatible name | Immutable within branch; rename replaces. Avoid a replacement that deletes populated data without forceDestroy. |
| access | `private` default or `public_read` | Desired mutable setting, but assessed public API/SDK has no PATCH. See explicit blocker below. |
| cors | optional CORS rules | Sync observed S3 CORS; removing managed rules deletes configuration. |
| tags | optional string map | Sync S3 bucket tags with protected internal ownership tags and `diffTags`. |
| forceDestroy | boolean; false | Deletion policy only; changing it does not recreate the bucket. |

Outputs: name/bucketName, projectId, branchId, access, createdAt, storage endpoint, region, forcePathStyle and observed managed settings/tags where supported. Stable identity is project + branch + name. Anonymous object URL is useful only for public_read; a private endpoint URL never implies anonymous access. SDK Bucket metadata has only name/access_level/created_at: creation time can belong to an ancestor, so it is not evidence of branch-local ownership.

### Bucket lifecycle and actual operations

1. Observe branch storage via `getProjectBranchStorage({ project_id, branch_id })` (GET `/projects/{project_id}/branches/{branch_id}/storage`); returns enabled, s3_endpoint, region, force_path_style. Read bucket existence/configuration through `listProjectBranchBuckets` and S3 `headBucket`, `getBucketCors`, `getBucketTagging`. Distinguish missing configuration from missing bucket with typed errors.
2. Ensure through `createProjectBranchBucket({ project_id, branch_id, name, access_level })` (POST branch `/buckets`). Catch typed create conflicts and re-observe ownership. Management list has no get-by-name operation; exact filtering is required.
3. Sync CORS with S3 `putBucketCors` / `deleteBucketCors`, tags with `putBucketTagging` / `deleteBucketTagging`. Compare observed state, not olds. Do not invent a Neon HTTP tags/CORS endpoint when supported S3 exists.
4. Sync access only with a documented and verified supported contract. Public OpenAPI on 2026-09-17 still has POST/GET `/buckets` and DELETE `/buckets/{bucket_name}`, no visibility PATCH. Public docs say Console/API can change access, while S3 `PutBucketAcl` / `PutBucketPolicy` return 501. SDK owner must locate evidence before adding an operation. If unavailable, return an explicit typed unsupported-update error, leave bucket contents/access unchanged and mark this feature partial. Never delete/recreate populated buckets merely to change visibility.
5. Delete: `deleteProjectBranchBucket({ project_id, branch_id, bucket_name })` or the verified S3 equivalent. Default nonempty bucket fails safely. With forceDestroy, enumerate only this owned branch/bucket via S3 `listObjectsV2` (continuation token), delete in `deleteObjects` batches ≤1000, enumerate `listMultipartUploads` and `abortMultipartUpload`, then delete and verify typed absence. Enforce pagination progress/limits and bounded races; never erase a parent lineage or unrelated bucket.

Do not expose S3 bucket notifications for Function events: those APIs are unsupported; use FunctionTrigger. Versioning/lifecycle configurations may be stored but are not enforced by Neon, so they are not advertised as supported policy behavior. Website serving is via Function, never bucket website hosting.

## Object<T> contract

| Prop | Type/default | Mutation/identity rule |
| --- | --- | --- |
| bucket | Bucket reference; required | Scope inferred; changing bucket identity replaces. |
| key | string; required | Identity; key move replaces with safe create-first ordering where identities differ. |
| value | mutually exclusive typed JSON value | Inferred/explicit T retained. Deterministic JSON serialization with application/json; content changes update. |
| body | mutually exclusive raw string/bytes | No JSON guessing; string is literal text. Preserve byte fidelity. |
| source | mutually exclusive filesystem path | Effect FileSystem reads content; do not serialize the path as object body. File-content changes update. |
| schema | optional Effect Schema for typed JSON | Runtime validation, distinct from generic-only contract. Changed schema does not imply key identity change. |
| contentType / cacheControl / contentDisposition / metadata | optional supported HTTP metadata | Changes update the object. JSON gets application/json unless explicitly supported override is validated. |

Outputs retain the generic on the resource, plus bucket identity, key, ETag, size, content hash and metadata. Content hash is Alchemy's deterministic digest, not an assumption that every ETag is an MD5. Raw resources expose raw read APIs; no fictional parsed JSON type. Reject invalid mixed inputs at compile time and runtime; reject unsupported JSON values (undefined members, functions, bigint, cycles/non-JSON instances as applicable) instead of silently losing them. Nested Alchemy Outputs resolve normally before encoding. `value` is infrastructure desired state: runtime writes to that key can be restored by reconciliation, so general application data should use bucket bindings instead.

### Object actual operations

- Data plane uses S3 `headObject`, `getObject`, `putObject`, `deleteObject`; optional metadata/tag support uses `getObjectTagging` / `putObjectTagging` / `deleteObjectTagging` if the design uses object tags for ownership. Observe ownership plus content metadata before ensure/sync. If provenance cannot be read reliably, require explicit adoption of existing objects.
- Neon management API supports `listProjectBranchBucketObjects`, `getProjectBranchBucketObject` (download), `deleteProjectBranchBucketObject`, `deleteProjectBranchBucketObjectsByPrefix`, and `presignProjectBranchBucketObject`. There is no management put-object operation. The assessed download response is `{}` and must not be used as if it already returns bytes; SDK owner fixes binary/redirect semantics.
- Management keys may contain `/`, encoded as `%2F` within the object-key path segment. S3 keys also require correct percent handling without normalizing application keys. Test spaces, Unicode, `+`, `%`, slashes and range requests.
- Presign permits GET/PUT with branch credentials; never leak account authentication into a presigned URL. URI expiry/authentication errors are typed and sanitized.

## Exact acceptance

Bucket: create private/public variants; private anonymous GET denied, public GET/HEAD succeeds but anonymous list/write/delete denied; S3 path-style/SigV4 works; CORS browser preflight + permitted origin roundtrip; tags converge including removals; no-op sends no writes; foreign/inherited adoption refusal; child deletion/write leaves parent unchanged; nonempty default delete preserves bytes; forceDestroy handles >one object page and pending multipart uploads only in its owned branch/bucket; repeated delete succeeds.

Visibility: live probe only in owned empty fixture, locate supported update or demonstrate typed unsupported-update preserving object hash/access. Do not claim access-update completion without live evidence. SDK/contract gap is not an entitlement skip.

Object: inferred and explicit generic compile cases; wrong typed writes and mixed value/body/source fail compile; JSON get/put roundtrip preserves T; optional schema rejects external invalid JSON with typed decode failure; malformed JSON fails even without schema; raw string and binary/file bytes are exact; metadata and content update; no-op avoids rewrite; key/bucket replacement leaves no owned old key; external mutation converges to desired; explicit adoption required for foreign existing key; parent copy-on-write isolation is verified.

Multipart: `createMultipartUpload`, `uploadPart`, `uploadPartCopy` where exposed, `listParts`, `completeMultipartUpload`, `abortMultipartUpload` and `listMultipartUploads`; real multipart roundtrip and aborted-upload cleanup. `WriteBucket` API includes supported multipart operations, not invented platform upload guarantees.

Storage feature availability remains unverified. Final preflight resolved credentials and listed zero accessible projects; region lookup returned typed NotFound. No storage read/write or cloud mutation ran; see preflight.md for the latest evidence. Ohio is the approved combined-backend example region, to verify for the selected account. Public source: https://neon.com/docs/storage/s3-compatibility and https://neon.com/api_spec/release/v2.json.
