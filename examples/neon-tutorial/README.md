# Neon upload journal

A Vite frontend with managed Better Auth, private object uploads, Postgres metadata, and a real storage-triggered Function. The default stack uses Effect; `alchemy.native.ts` exposes the same API through a native Fetch handler.

Read the [step-by-step tutorial](https://alchemy.run/neon/tutorial) for the resource and binding definitions.

## Run

Install this repository's workspace dependencies and use Node 24. Configure the Neon `testing` profile or provide `NEON_API_KEY` to the deployment process only. The example uses `aws-us-east-2` and creates billable cloud resources.

From this directory, choose one backend:

```sh
pnpm deploy --profile testing --stage upload-journal
# Or, for the separate native stack:
pnpm deploy:native --profile testing --stage upload-journal
```

Open the returned website URL. Create an account, select a small file, and submit it. A storage event validates the uploaded metadata and updates the journal; the browser does not mark the upload ready itself.

To run only the frontend against that deployed backend:

```sh
VITE_API_URL='<apiUrl>' VITE_NEON_AUTH_URL='<authUrl>' pnpm dev:web
```

The frontend listens at `http://127.0.0.1:43187`. The example deliberately allows localhost and disables email verification. Every data request still requires a verified JWT. Set `UPLOAD_APP_ORIGIN` before deployment to restrict API origins. No deployment API key belongs in a `VITE_*` variable.

## Verification limits

The full signed-in upload, event-backed status, byte-for-byte browser download, and isolated preview flows are not accepted yet. Focused storage and Auth suites passed separately, but they do not establish this complete application flow.

Neon Function update probes have served old code/environment even after the requested active deployment ID advanced. The preview's resource-scoped Auth adoption was also rejected during verification. Keep those failures visible; do not substitute deployment credentials, use stack-wide adoption, or erase state to proceed.

The 10 MiB upload limit is an application check, not an S3-enforced quota. Processing validates size/content type, not malware. Signed URLs are temporary bearer capabilities. Add production rate limits, budgets, email verification, and content validation before exposing this application.

## Cleanup

Keep `.alchemy` and use the same stage as deployment. Destroy preview stacks before their parents, with the parent identity environment variables still set:

```sh
pnpm preview:destroy --profile testing --stage upload-preview
pnpm destroy --profile testing --stage upload-journal
# If you deployed the native alternative:
pnpm destroy:native --profile testing --stage upload-journal
```

The native and Effect variants are independent stacks. Destroy both if you deployed both. Bucket destruction intentionally deletes its files. Never delete local state as a substitute for cloud cleanup.
