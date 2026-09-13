# dashboard-aws

Deploys the alchemy dashboard as a **hosted state viewer** on AWS: the
`@alchemy.run/dashboard` SPA on S3 + CloudFront, with `/api/*` routed to a
Lambda serving the read-only viewer API straight from the S3 state store —
no CLI process and no long-lived credentials (the Lambda's execution role
gets `s3:ListBucket`/`s3:GetObject` on the state bucket and `kms:Decrypt`
for the store's envelope-encrypted secrets).

```sh
bun run deploy
```

Lambda Function URLs buffer responses, so the viewer serves its live stream
as snapshot polling instead of one open SSE connection.

The distribution is public: put it behind your own gate (a WAF rule,
Lambda@Edge auth, a VPN) before sharing the URL.
