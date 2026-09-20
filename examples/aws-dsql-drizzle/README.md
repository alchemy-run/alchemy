# Drizzle + Aurora DSQL + Lambda

A standalone Effect-native Lambda using Drizzle over Aurora DSQL's PostgreSQL wire endpoint. This is **Aurora DSQL**, not Aurora PostgreSQL or the RDS Data API.

[Integration guide](https://alchemy.run/aws/data/drizzle-dsql/) · [SQL on AWS](https://alchemy.run/sql/providers/aws/)

## Run

From the repository root:

```sh
pnpm install
cd examples/aws-dsql-drizzle
pnpm deploy --profile testing
```

Configure [AWS credentials](https://alchemy.run/aws/setup/) and select a DSQL-supported region, such as `us-west-2`. The deployment identity needs resource provisioning permissions, `dsql:DbConnectAdmin`, and outbound access to the cluster on port 5432. DSQL and Lambda incur AWS charges.

The deployment creates a DSQL cluster, a Lambda with an IAM-authenticated Function URL, and an initial schema Action. There is no VPC, password secret, or public setup route.

## Query

Use the printed `functionName` for an authenticated health query:

```sh
aws lambda invoke --region us-west-2 \
  --function-name <functionName> \
  --cli-binary-format raw-in-base64-out \
  --payload file://health-event.json response.json
cat response.json
```

The database username is `app_user`. The Function URL requires SigV4-signed requests; `test/integ.test.ts` contains a complete signing helper and exercises `GET /todos`, `POST /todos`, `PATCH /todos/:id`, and `DELETE /todos/:id`.

## Credentials and schema setup

`BootstrapDatabase` runs on the deployment machine as the DSQL administrator. It creates `app.todos`, grants only schema usage and table CRUD to `app_user`, and maps that database role to the Lambda execution role using `AWS IAM GRANT`.

The Lambda has cluster-scoped `dsql:DbConnect`, never `dsql:DbConnectAdmin`. Each invocation resolves a fresh IAM token when its connection opens. Both deployment and runtime clients verify TLS certificates and hostnames.

DSQL catalog changes run as separate autocommit statements. The initial setup tolerates replay, but `CREATE TABLE IF NOT EXISTS` does **not** migrate an existing table. For later schema changes, use reviewed, versioned DSQL-compatible SQL from an authorized deployment task. `AWS.DSQL.Cluster` does not accept a `migrations` prop.

The schema uses caller-supplied UUIDs, not sequences or `serial`, and declares no foreign keys. DSQL has additional PostgreSQL differences and transaction restrictions: consult the [DSQL compatibility documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html).

## Live test

```sh
ALCHEMY_PROFILE=testing bun test test/integ.test.ts
```

The test deploys twice, verifies anonymous access is rejected, checks the runtime role's IAM policy, and exercises CRUD, invalid input, repeated invocations, and cleanup against AWS. It also verifies that DSQL accepted cluster deletion. AWS can retain a `DELETING` record for several minutes after the destroy command returns; use `aws dsql get-cluster --identifier <clusterId> --region us-west-2` to check for `DELETED` or `ResourceNotFoundException`.

## Clean up

```sh
pnpm destroy --profile testing
```

Deletion protection is disabled for this disposable example. Destroy removes the cluster and all its data, the Lambda, its execution role, and its logs.
