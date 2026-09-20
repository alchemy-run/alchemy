# Drizzle + Aurora PostgreSQL + AWS Lambda

A standalone example using `alchemy/Drizzle/Postgres` with Aurora PostgreSQL 17, IAM database authentication, verified TLS, and a Lambda HTTP handler. This is **Aurora PostgreSQL**, not Aurora DSQL or Drizzle over the RDS Data API.

[Integration guide](https://alchemy.run/aws/data/drizzle-aurora/) · [SQL on AWS](https://alchemy.run/sql/providers/aws/)

## Prerequisites

- Install the repository dependencies with `pnpm install` from the repository root.
- Configure an [Alchemy AWS profile](https://alchemy.run/aws/setup/) with deployment permissions for VPC, RDS, Secrets Manager, IAM, Lambda, CloudWatch Logs, and the RDS Data API.
- Use **us-west-2**: the two private subnets are in `us-west-2a` and `us-west-2b`. Changing region also requires changing those availability zones and checking Aurora version/Data API availability.
- Allow several minutes for Aurora creation and deletion. The cluster incurs charges until destroyed (minimum 0.5 Aurora capacity units). This example is not configured for auto-pause or production retention.

## Deploy

From this directory:

```sh
pnpm deploy --profile testing --stage aurora-example
```

`src/database.ts` creates an isolated VPC, two subnets, security groups, a generated admin secret, and an Aurora writer. Only the Lambda security group may connect to TCP 5432. There is no public database endpoint, NAT gateway, or internet gateway.

`src/bootstrap.ts` runs a deployment Action using the Data API and the deployment identity. Its atomic, replay-safe initial migration creates the table and `app_iam` login, grants `rds_iam`, and grants only table CRUD and schema usage. The Action waits for the writer and its output orders Lambda deployment after setup. It runs again when its input changes or deployment is forced; it is not a general Drizzle migration runner. For schema evolution, add reviewed, versioned migrations with a history table rather than editing an already-applied initial migration.

The deployment machine needs access to AWS HTTPS APIs, **not** a route into the VPC. Runtime queries use a private PostgreSQL socket, not the Data API. The application role has `rds-db:connect` for `app_iam`; it does not receive the admin secret or Data API grants.

## Call the HTTP API

The output `url` uses AWS IAM authentication. Unsigned HTTP requests are rejected. Use a SigV4-capable HTTP client authorized for both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on this function. Alternatively, invoke the same HTTP handler using the AWS CLI and the output `functionName`:

```sh
aws lambda invoke --region us-west-2 \
  --function-name '<functionName>' \
  --cli-binary-format raw-in-base64-out \
  --payload file://health-event.json response.json
```

The AWS CLI uses its own configured credentials, not Alchemy's `--profile` setting. `response.json` contains an HTTP response whose JSON body reports `app_iam`, TLS enabled, INSERT allowed, and schema CREATE denied.

| Method | Path | Body |
| --- | --- | --- |
| GET | `/health` | — |
| GET | `/todos` | — |
| POST | `/todos` | `{"id":"aaaaaaaa-0000-4000-8000-000000000001","title":"Ship it"}` |
| PATCH | `/todos/<uuid>` | `{"done":true}` |
| DELETE | `/todos/<uuid>` | — |

For direct invocation, change `rawPath` and `requestContext.http.path` in the event, set `requestContext.http.method`, and encode the request JSON as the event's `body` string. There is no `/setup` or `/migrate` route.

## TLS and connection lifetime

The function sets `NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem`, loading the Amazon CAs supplied by the managed Node.js Lambda runtime. It changes the connection URL's current `sslmode=no-verify` default to `verify-full`. Both hostname and certificate-chain verification remain enabled. This certificate path is specific to the managed Lambda runtime, not a portable container path.

The connection Effect generates a fresh IAM token when Drizzle first opens a pool in each invocation. Queries in that invocation share the pool; the invocation scope closes it afterward. No password or token is logged or returned by the API.

## Live integration test

```sh
AWS_TEST_SLOW=1 ALCHEMY_PROFILE=testing bun test test/integ.test.ts
```

This opt-in test destroys any previous test-stage deployment, deploys the whole example including schema setup, redeploys without schema changes, rejects unsigned requests, calls the IAM-authenticated Function URL with SigV4-signed HTTP, and checks CRUD/validation/repeated invocations and SQL privileges, then destroys the stack. Without `AWS_TEST_SLOW=1`, the suite skips without provisioning. Provisioning and cleanup have finite 25-minute budgets; query assertions have a two-minute budget.

## Destroy

```sh
pnpm destroy --profile testing --stage aurora-example
```

This deletes the example database and its data. Do not use the example's disposable retention settings for production. Wait for cleanup to finish; if interrupted, rerun the same destroy command with the same profile and stage.
