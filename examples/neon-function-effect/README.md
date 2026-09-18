# Effect Neon Function

Deploys a project, branch, storage bucket, and Effect-native Function. `Api.ts` binds the branch through `Neon.Connect`, queries Postgres, lists `uploads/` objects, and authenticates requests with an application bearer token. `LayerApi.ts` demonstrates the `.make` Layer form but is not deployed by the default stack.

## Environment

Run from this directory after installing the repository workspace dependencies. Use Node 24 and a Neon account with Functions and Storage enabled.

```sh
export NEON_API_KEY='<deployment-account-api-key>'
export APP_TOKEN='<application-bearer-token>'
```

Alchemy resolves `Config.Redacted("APP_TOKEN")` during deployment and binds it to the Function. `NEON_API_KEY` is a deployment credential, not a runtime application credential. The Function URL remains public; the handler's bearer check is the access-control boundary.

## Deploy and invoke

```sh
pnpm --config.verify-deps-before-run=false deploy --stage demo
```

Copy the returned `url`:

```sh
export API_URL='https://<returned-function-url>/'
curl --fail-with-body -H "Authorization: Bearer $APP_TOKEN" "$API_URL"
curl -i "$API_URL"
```

The authenticated response contains `rows` from Postgres and `objects` from the bucket. An empty bucket is valid. The unauthenticated request returns 401.

The SQL client is constructed during Function initialization, but its connections are acquired per request. Request finalizers must not be confused with instance shutdown. Standalone Effect constructor and `.make` invocation, normal HTTP/SSE/HEAD/204 finalizers, and independent-scope `waitUntil` have passed live checks.

## Destroy

If you added objects to the bucket, remove them first using the branch's storage client. The example does not enable destructive bucket draining.

```sh
pnpm --config.verify-deps-before-run=false destroy --stage demo
```

Keep `.alchemy` state until destruction succeeds. Do not delete state or adopt unrelated resources to bypass cleanup failures.

## Current limitations

Local Fetch execution and application-environment restarts are tested with Neon CLI 4.21.1 behind the RPC sidecar. That result does not establish local database/storage acceptance for this composed example; its project, branch, and bucket remain live resources.

Live code/environment updates can advance the active deployment ID while serving stale values, even with a full ZIP. No workaround is verified. Live network-abort and WebSocket-close finalization remain failing acceptance checks; the corresponding tests are not skipped. Log-query delivery is also unverified. The storage owner's cleanup fixes are a prerequisite for complete composed-example acceptance.
