# Neon storage

This example deploys a Neon project and branch, a private uploads bucket, a public-read assets bucket, a typed JSON settings object, and native and Effect Function endpoints.

## Run

Use Node 24+, the workspace dependencies, and a configured Alchemy Neon deployment profile. Set `NEON_STORAGE_APP_TOKEN` to a secret application bearer token before deploying. It is independent of the Neon deployment account key.

From this directory, run `pnpm --config.verify-deps-before-run=false deploy --profile testing`. The stack prints `nativeUrl`, `effectUrl`, and the public bucket name. Pass `Authorization: Bearer <NEON_STORAGE_APP_TOKEN>` when calling either Function.

- Native: `PUT /` stores bytes at `incoming/native.txt`; `GET /` reads them; `GET /upload-url` returns a presigned upload URL.
- Effect: `PUT /` stores text at `incoming/message.txt`; `GET /` returns a presigned download URL; `GET /settings` reads typed settings; `GET /upload-url` returns a presigned upload URL and required headers for `incoming/browser.txt`.

Upload URLs last five minutes. Use the returned `content-type` header for the Effect upload URL. Treat presigned URLs as temporary bearer credentials. Browser CORS permits `http://localhost:5173`; change the allowed origin in `resources.ts` for your application.

Run `pnpm --config.verify-deps-before-run=false destroy --profile testing` when finished. Both buckets enable `forceDestroy`, so destruction removes their objects and incomplete multipart uploads before deleting the buckets and revoking their management credentials. The example uses local state; retain it until cleanup finishes.

## Credentials and typed storage

Same-branch deployed Neon Functions use the platform's injected S3 credentials. Their runtime does not need the deployment account key. Each bucket has a separately tracked management credential for declarative objects and cleanup. Local, cross-branch, Worker, and Lambda storage bindings use separately managed service credentials unless an explicit override is supplied.

Managed readers request `storage:read`. Managed writers request **both `storage:read` and `storage:write`**: live S3 tests observed write-only credentials rejected with `AccessDeniedException` / HTTP 403. Do not rely on the documented write-implies-read behavior. Credentials authorize the branch and descendants, not an individual bucket or object key; a typed capability narrows the application interface, not the underlying credential's permission scope.

`Neon.Object` serializes JSON values and preserves their TypeScript type through `ReadObject` and `WriteObject`. The settings object also has an Effect schema for runtime validation of external writes. It is infrastructure desired state: reconciliation restores the declared value. Store mutable application data through bucket bindings rather than declaring it as an object resource. Raw `body` and file `source` inputs are uploaded without JSON serialization.

The Effect HTTP boundary returns a generic 500 response for storage failures without exposing credentials or SDK error details. Both endpoints require application authorization even though Neon supplies S3 credentials internally.

## Local verification

The local storage binding test runs by default and requires Node 24+, Neon CLI, and Neon deployment credentials: the Function is local, but its buckets and scoped credentials are real cloud resources. The workspace installs Neon CLI 4.21.1 in `examples/neon-function/node_modules/.bin`; add that directory to `PATH` when running the suite from the repository root. No global CLI installation is needed.

Run `PATH="$PWD/examples/neon-function/node_modules/.bin:$PATH" timeout 240 pnpm --config.verify-deps-before-run=false test test/Neon/StorageBinding.local.test.ts --profile testing --retry 0 --timeout 120000`. The suite uses the RPC sidecar and normal stack destruction to stop the local Function and remove its remote storage resources.

## Verification and current limitations

The storage suites have exercised bucket lifecycle/CORS/tags, JSON and raw-file fidelity, multipart cleanup, more than 1,000 objects, credential scope validation/revocation, native and Effect Function roundtrips, local RPC-sidecar bindings, and external Worker/Lambda HTTP bindings. Recovery tests require observed ownership tags even when no cached bucket identity or explicit name exists; an empty tag set or generated name is not ownership evidence.

This example itself has not been deployed during the focused storage recovery pass. Repeated live Effect `WriteObject` requests exposed an HTML HTTP 500 response to S3 PUT that Distilled incorrectly classified as `ParseError`. The companion SDK correction classifies code-less REST-XML server failures as `InternalError`, preserving structured errors and enabling the existing bounded retry policy without logging the response body. After that correction, all five native, Effect, local, Worker, and Lambda binding tests passed together, including eight consecutive typed writes and normal cleanup. The upstream cause of the intermittent server response remains unknown.

Neon currently rejects inherited-bucket tag writes with `NoSuchBucket`, so adopting inherited bucket configuration is gated in the tests even though inherited reads and branch-local data writes/deletes have been verified. Bucket visibility updates are unsupported rather than silently replacing stored data. Separate Function code/environment-update tests have observed stale served deployments; do not treat storage roundtrips as verification of Function update propagation.
