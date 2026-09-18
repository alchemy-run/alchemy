# Native Neon Function

Deploys a Neon project and a Node 24 Fetch Function. `api.ts` exposes `/health` and a bearer-authenticated database query. `bare.ts` and `hono.ts` are alternative native entrypoint examples; the default stack deploys only `api.ts`.

## Environment

Run from this directory after installing the repository workspace dependencies. Use Node 24 and a Neon account with Functions enabled. The workspace pins `neonctl` 4.21.1; local Functions require CLI 2.45.0 or newer.

```sh
export NEON_API_KEY='<deployment-account-api-key>'
export APP_TOKEN='<application-bearer-token>'
```

`NEON_API_KEY` authenticates deployment and is not forwarded to the Function. Neon injects `DATABASE_URL` into the deployed Function. Do not override platform-injected environment names. `APP_TOKEN` is an application secret, not a Neon invocation credential.

## Deploy and invoke

```sh
pnpm --config.verify-deps-before-run=false deploy --stage demo
```

Copy the returned `url` into `API_URL`:

```sh
export API_URL='https://<returned-function-url>/'
curl --fail-with-body "${API_URL%/}/health"
curl --fail-with-body -H "Authorization: Bearer $APP_TOKEN" "$API_URL"
```

The health request returns `{"ok":true}`. The authenticated request returns the current database name. Requests to the database route without the bearer token return 401. The Function URL itself is public; a `functions:invoke` credential does not make it private.

## Local mode

```sh
pnpm --config.verify-deps-before-run=false dev --stage local-demo
```

Use the printed localhost URL for `/health`. Local mode runs the real Neon CLI behind Alchemy's sidecar and supports application-environment restarts. The project is still a live resource. Native branch-injected database/storage credentials are not emulated by the local Function provider; use the live deployment for this example's database route. Stop the dev command before destroying the local stage.

## Destroy

```sh
pnpm --config.verify-deps-before-run=false destroy --stage demo
pnpm --config.verify-deps-before-run=false destroy --stage local-demo
```

Run the second command only if you created that stage. Keep the local `.alchemy` state until destruction completes; do not remove state to work around cleanup errors.

## Current limitations

Live checks found that code/environment updates can report a new active deployment ID while still serving old code/environment values, including full-ZIP updates. There is no verified workaround. Live network-abort and WebSocket-close finalization remain failing acceptance checks, and application log-query delivery is not verified. Initial native/Hono invocation and local environment restarts have passed; these results do not establish update or disconnect acceptance.
