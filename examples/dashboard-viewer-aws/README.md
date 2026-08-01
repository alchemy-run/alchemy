# dashboard-viewer-aws

Deploys the alchemy dashboard as a **hosted state viewer on AWS**, reading
the S3 state store (`AWS.state()`) directly — no CLI process required.

Architecture: one CloudFront distribution (`AWS.Website.Router`) serving
the `@alchemy.run/dashboard` SPA from S3 and routing `/api/*` to a Lambda
running the read-only viewer API (`alchemy/Dashboard/Viewer`) over
`makeS3State`. The Lambda's execution role carries the read permissions
(`s3:GetObject` / `s3:ListBucket` on the state bucket, `kms:Decrypt` for
the store's envelope-encrypted secrets) — there are no long-lived
credentials anywhere.

Because Lambda Function URLs buffer responses, the viewer runs SSE in
`poll` mode: each connection delivers one snapshot and closes, and the
browser's EventSource auto-reconnect turns that into snapshot polling.

## Configure

Nothing is required when your stacks use the default `AWS.state()` bucket
(`alchemy-state-{account}-{region}-an`) in the same account/region you
deploy this viewer to. Optional:

```sh
export ALCHEMY_STATE_BUCKET="my-company-state"  # custom state bucket
export ALCHEMY_STATE_PREFIX="alchemy"           # key prefix inside the bucket
export ALCHEMY_VIEWER_STACK="MyStack"           # default: first stack in the store
export ALCHEMY_VIEWER_STAGE="prod"              # default: first stage of the stack
export ALCHEMY_DASHBOARD_DIST=".../dist"        # default: ../../packages/dashboard/dist
```

## Deploy

```sh
bun run deploy
```

`predeploy` builds the SPA (`packages/dashboard/dist`); the deploy uploads
it behind CloudFront and wires `/api/*` to the Lambda.

## Access control

The viewer exposes everything its role can read from the state store
(resource props/attrs, deployment journals, outputs). Put the CloudFront
URL behind your access layer of choice (CloudFront + WAF, Lambda@Edge
auth, or a VPN) before sharing it.
