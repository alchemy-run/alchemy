# AWS dev bridges: inventory

Regenerate the member lists with `node scripts/check-dev-bridges.ts --inventory`.
Emulated hosts are Lambda Functions and ECS Tasks/Services in floci;
`Alchemy.remote()` moves any resource to the real cloud.

| Class | Members | Strategy | Seam | Status | Test |
| --- | --- | --- | --- | --- | --- |
| public API call | every AWS binding (~340 operations, 74 seam files) | Direct | `AWSBindings.Bind` + `withCredentials` (per call, `Binding.Targets`) | bridged | `Function.local.test.ts` › bindings reach `Alchemy.remote()` resources (S3 + SQS); `EcsDev.local.test.ts` › ECS task reaches a remote bucket |
| pull event → Lambda | SQS, Kinesis, DynamoDB Streams, Kafka, MQ, DocumentDB | Stub host (the real mapping polls) | `Lambda/DevBridge.ts` `wireEventSource` | bridged | `Function.local.test.ts` › consumes event sources in the real cloud (SQS, then promoted to deploy: stub collected) |
| push event → Lambda | S3, SNS, EventBridge (incl. the 82 service-event sources on the default bus), API Gateway REST + WebSocket, Cognito triggers, Secrets Manager rotation, CloudWatch Logs, AppConfig, IoT, IoT Wireless, IVS Chat, Lex, Pipes `.toLambda` | Stub host | `wireEventSource` (EventBridge via `toLambda`) | bridged | same test (S3 notifications); › push sources reach a dev Function (REST response + 502 on error, custom bus) |
| schedule → Lambda | Scheduler | emulated (floci runs schedules) | `wireEventSource` with no origin | emulated | — |
| event → other target | EventBridge `toQueue`/`toEcsTask`, Pipes `.toQueue` | Reject | `requireSameSide` | rejected by name | `Function.local.test.ts` › rejects the edges (bus → emulated queue) |
| real-cloud resource ← emulated input | any live resource whose props or bindings come from an emulated one (e.g. a remote Lambda bound to a local bucket) | Reject | `Plan.ts` (core, all clouds) | rejected by name | `provider-mode.test.ts`; `Function.local.test.ts` › rejects the edges (deployed Function on an emulated queue) |
| private connect | DAX, DocumentDB, ElastiCache (3), MemoryDB | Reject (Tunnel later) | `Bind`, `PRIVATE_ENDPOINT_SERVICES` | rejected by name | `Function.local.test.ts` › rejects the edges (ElastiCache) |
| public-capable connect | DSQL, Kafka, RDS, Redshift, Redshift Serverless | Direct (network) | `Bind` | works when the endpoint is public; a private one fails to connect | — |
| server event source | ECS `Server/*EventSource` (polls inside the container) | Direct | composes call bindings | bridged | — |
| foreign: local Worker → remote AWS | any AWS binding on a non-AWS emulated host | Reject (Direct needs a credential relay for non-floci hosts) | `Bind` | rejected by name | `Local/CloudflareHost.local.test.ts` |

## Open

- **Foreign Direct.** A local Cloudflare Worker calling a real-cloud AWS
  resource is rejected. Bridging it needs the developer-credential relay to
  reach hosts that no floci dev-watch provider runs.
- **Tunnel.** VPC-only endpoints are rejected; a port forward (SSM Session
  Manager through a managed instance) would bridge them.
- **Ingress.** URL-push sources aimed at local code (SNS HTTPS
  subscriptions, EventBridge API destinations) aren't classified yet.
- **Local resource on a real source.** An emulated resource configured with
  a real-cloud source (e.g. a local SNS subscription on a remote topic) is
  not rejected by name; floci fails it at reconcile.
- **Distilled.** S3 `PutBucketNotificationConfiguration` returns
  `UnknownAwsError` for an invalid destination ("notification destination
  service region is not valid"); type it in `patches/s3.json`.
