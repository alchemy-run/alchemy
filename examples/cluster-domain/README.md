# cluster-domain

A bank built with `@alchemy.run/domain` and hosted on [Effect Cluster](https://alchemy.run/domain/effect-cluster). Customers open accounts, deposit and withdraw, and transfer money. A saga moves each transfer: it debits one account, credits the other, and refunds the debit if the credit fails.

## Layout

```text
packages/
  domain/   @cluster-bank/domain   the model: one <Noun>.<kind>.ts per building block, plus its stories
  server/   @cluster-bank/server   the platform Layers, the session middleware, the HTTP Api
    src/BankLive.ts                hostBank(platform): the model + middleware on any platform
    src/Docker/                    Postgres + 2 runners on your Docker swarm, the Api as a Docker service
    src/AWS/                       Postgres on RDS + 2 runners on ECS Fargate, the Api on Lambda
    src/Cloudflare/                a Durable Object per entity instance, the Api as a Worker
alchemy.run.ts                     the stack: Docker by default, BANK_TARGET=aws or BANK_TARGET=cloudflare
```

The model never changes between targets. Only the platform Layer passed to `hostBank` does:

```ts
// packages/server/src/Docker/Bank.ts
export const Database = ClusterDocker.Database("BankCluster");
export const Pool = ClusterDocker.SwarmPool("Runners", { replicas: 2 }).pipe(Layer.provide(Database));

export default hostBank(
  DomainCluster.layerEntities({ name: "Bank", main: import.meta.url, pool: Pool }),
);
```

```ts
// packages/server/src/AWS/Bank.ts
export const Database = ClusterAWS.Database("BankCluster");
export const Pool = ClusterAWS.EcsPool("Runners", { replicas: 2 }).pipe(Layer.provide(Database));

export default hostBank(
  DomainCluster.layerEntities({ name: "Bank", main: import.meta.url, pool: Pool }),
);
```

The tests pass `Domain.InMemory` instead.

## Test

```sh
pnpm --filter @cluster-bank/domain test   # stories: the whole model, in memory
pnpm --filter @cluster-bank/server test   # the HTTP Api, in memory
```

`test/integ.test.ts` deploys the stack, drives its HTTP Api end to end, and destroys it. `BANK_TARGET` picks the target, as it does for a deploy:

```sh
pnpm test:integ              # Docker
pnpm test:integ:cloudflare   # Cloudflare
```

## Deploy to Docker

```sh
docker swarm init   # once
pnpm deploy
```

The Api has no sign-in, because this is a demo. A request acts as the customer named in its `x-customer` header.

```sh
curl -X POST localhost:8080/OpenAccount -H "x-customer: sam" \
  -d '{ "target": "sam-1", "commandId": "o-1", "input": { "name": "everyday" } }'
curl -X POST localhost:8080/OpenAccount -H "x-customer: ada" \
  -d '{ "target": "ada-1", "commandId": "o-2", "input": { "name": "savings" } }'
curl -X POST localhost:8080/DepositMoney -H "x-customer: sam" \
  -d '{ "target": "sam-1", "commandId": "d-1", "input": { "amount": 100 } }'
curl -X POST localhost:8080/RequestTransfer -H "x-customer: sam" \
  -d '{ "target": "t-1", "commandId": "t-1", "input": { "from": "sam-1", "to": "ada-1", "amount": 40 } }'
curl localhost:8080/TransferStatus/t-1 -H "x-customer: sam"
curl localhost:8080/AccountSummary/ada-1 -H "x-customer: ada"
curl localhost:8080/openapi.json
```

```sh
pnpm destroy
```

## Deploy to AWS

`BANK_TARGET=aws` switches the same stack to AWS (`pnpm deploy:aws` sets it for you):

```sh
BANK_TARGET=aws pnpm deploy --stage aws --profile <your-profile>
BANK_TARGET=aws pnpm destroy --stage aws --profile <your-profile>
```

Give each target its own stage. Switching the target on one stage replaces the Docker resources with AWS ones, and the other way round.

The stack prints the Lambda function URL. Use it in place of `localhost:8080`.

## Deploy to Cloudflare

On Cloudflare, Effect Cluster runs each entity instance in a Durable Object, which keeps the instance's data in its own storage. There is no database and no runners.

```ts
// packages/server/src/Cloudflare/Bank.ts
export const Pool = ClusterCloudflare.DurableObjectPool("Runners");

export default hostBank(
  DomainCluster.layerEntities({ name: "Bank", main: import.meta.url, pool: Pool }),
);
```

```sh
BANK_TARGET=cloudflare pnpm deploy --stage cloudflare --profile <your-profile>
BANK_TARGET=cloudflare pnpm destroy --stage cloudflare --profile <your-profile>
```

The stack prints the Worker's URL. Use it in place of `localhost:8080`.
