# Neon Function triggers

Deploys Effect and native Functions on one branch. The Effect Function handles a daily schedule and uploads whose object keys start with `incoming/`. The native Function has its own daily schedule. Both schedules run at **02:00 UTC**.

Handlers record invocation IDs as primary keys in Postgres. This makes the demonstrated writes idempotent; it is not a guarantee of exactly-once delivery for arbitrary application side effects.

## Environment and deploy

Run from this directory after installing the repository workspace dependencies. Use Node 24 and a Neon account with Functions, Storage, and triggers enabled.

```sh
export NEON_API_KEY='<deployment-account-api-key>'
pnpm --config.verify-deps-before-run=false deploy --stage demo
```

The stack returns `effectUrl` and `nativeUrl`. Neon supplies deployed Functions with their branch database credentials. Never pass the deployment account key to either handler.

## Invoke with a real upload

Obtain the deployed branch's storage endpoint and credentials through Neon, and identify the `Uploads` bucket. These are storage credentials, not `NEON_API_KEY`.

With an S3-compatible CLI configured for those credentials:

```sh
export AWS_ACCESS_KEY_ID='<branch-storage-access-key>'
export AWS_SECRET_ACCESS_KEY='<branch-storage-secret-key>'
export AWS_REGION='<branch-storage-region>'
export AWS_ENDPOINT_URL_S3='<branch-storage-endpoint>'
export BUCKET_NAME='<deployed-Uploads-bucket-name>'
aws --endpoint-url "$AWS_ENDPOINT_URL_S3" s3 cp ./event.txt "s3://$BUCKET_NAME/incoming/event.txt"
```

Create `event.txt` locally before running the upload. A successful upload should invoke the Effect route and insert an `upload` row in `processed_events`. A key outside `incoming/` must not match. Inspect `processed_events` in the deployed branch's SQL editor. After a scheduled occurrence, inspect its `schedule` rows and the native handler's `native_events` table. Tables are created on first delivery, so querying them before an event can report that they do not exist.

Public URLs do not authorize callers to impersonate Neon triggers. For example, this unattested request must be rejected with 403:

```sh
export EFFECT_URL='https://<returned-effectUrl>/'
curl -i -X POST "${EFFECT_URL%/}/__alchemy/neon/bucket/Uploads"
```

Do not synthesize `X-Neon-*` headers to claim a successful trigger test. Trust the invocation header only behind Neon's edge. This example does not expose a public event-listing route.

## Destroy

Delete uploaded objects before destroying the stack; bucket draining is not enabled by this example.

```sh
aws --endpoint-url "$AWS_ENDPOINT_URL_S3" s3 rm "s3://$BUCKET_NAME/incoming/event.txt"
pnpm --config.verify-deps-before-run=false destroy --stage demo
```

Remove any other objects you added as well. Normal stack destruction removes the separately tracked triggers before their dependencies. Keep `.alchemy` state until cleanup succeeds.

## Current limitations

Use a live deployment for trigger acceptance. The local CLI does not emulate delivery of these cloud triggers; the composed stack is not a local trigger simulator. The broader event-source suite remains blocked on storage-owned cleanup fixes and has not been rerun as part of local Function acceptance.

Live Function code/environment updates can serve stale values despite a new active deployment ID; full-ZIP updates are not a verified workaround. Live network-abort/WebSocket-close finalization and application log-query delivery also remain unresolved. Do not treat these example instructions as a claim that those checks passed.
