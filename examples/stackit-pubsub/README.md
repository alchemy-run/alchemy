# STACKIT Pub/Sub job queue

A background job queue. An API publishes jobs on a `Stackit.PubSub.Topic`. A worker consumes them through an event source, and writes each result to a bucket, where the API serves it.

```sh
curl -X POST "$URL/jobs" -d '{"payload":"hello world"}'
# 202 {"id":"5f0c…","status":"pending"}
curl "$URL/jobs/5f0c…"
# 200 {"id":"5f0c…","status":"done","words":2,"chars":11}
```

## Architecture

- [`src/resources.ts`](./src/resources.ts): the topic, the subscription, and the bucket.
- [`src/Api.ts`](./src/Api.ts): the producer, a `Stackit.ContainerApplications.Application`.
- [`src/Worker.ts`](./src/Worker.ts): the consumer, an Application with one instance that pulls for as long as it runs. STACKIT Pub/Sub has no push delivery, so a consumer needs a host that keeps running. STACKIT doesn't document whether a Function's instances do.
- [`src/registry.ts`](./src/registry.ts): the environment, the registry project, and its logins.

## Bindings and event sources

| Host   | Binding / event source                                                                | Access                                                                                 |
| ------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Api    | `Stackit.PubSub.Publish(Jobs)` + `PublishHttp`                                        | A service account key for this host, added to this topic's publishers.                 |
| Api    | `Stackit.ObjectStorage.ReadBucket(Results)` + `ReadBucketHttp`                        | An access key whose group the bucket's policy limits to reads there.                   |
| Worker | `Stackit.PubSub.consumeSubscriptionMessages(JobsSubscription)` + `ServerSubscriptionEventSource` | A service account key for this host, added to this subscription's subscribers. |
| Worker | `Stackit.ObjectStorage.WriteBucket(Results)` + `WriteBucketHttp`                      | An access key whose group the bucket's policy limits to writes there.                  |

## Delivery

Delivery is at least once. A handler that succeeds acknowledges its message, and one that fails hands it back. STACKIT Pub/Sub has no dead-letter topic, so succeeding is the only way to stop a message coming back: the worker logs a message it can't parse and lets it succeed.

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).
- Docker running on your machine.
- A registry login: `HARBOR_USERNAME` and `HARBOR_CLI_SECRET`, your Harbor user and CLI secret from your user profile in the registry UI.
- Access to Container Applications, a beta API in `eu01` only, and to STACKIT Pub/Sub.

## Cost

The worker runs one instance for as long as the stack is deployed. STACKIT's price list (v1.0.44) has no SKU for Container Applications or Pub/Sub, so the hourly cost is unknown. Check the current price list, and destroy the stack when you're done. Object Storage bills what you store. Container Registry is free during its beta.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-pubsub
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, reads the subscription through the API, publishes a job and polls until its result appears, then destroys the stack and checks that the applications and the topic are gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- The API takes a pinned image reference (`repo@sha256:...`), and the applications run on `linux/amd64` images, which Alchemy assumes.
- The topic's publishers and the subscription's subscribers are enough for the data plane. If a list alone gets a 401 or 403, the bindings need more.
- The worker's first pull succeeds once its grant has propagated. It stops after ten failed pulls in a row, about two minutes, for the platform to restart it.

## Destroy

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name> --stage test_$USER
```

The API can't delete a Container Applications environment, so a destroy leaves `Apps` behind. Its generated name is stable, so the next deploy finds it again.
