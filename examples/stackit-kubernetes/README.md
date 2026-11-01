# Kubernetes on STACKIT SKE

A `Stackit.SKE.Cluster` with two `Kubernetes.Deployment`s, each behind a load balancer of its own: an Effect program bundled into a generated image, and a public nginx image with no build. No YAML, and no `kubectl apply`.

```sh
curl "$API_URL/zone"
# {"zoneId":"5f0c…"}
curl "$WEB_URL/"
# <h1>Welcome to nginx!</h1> …
```

## Architecture

- [`src/infra.ts`](./src/infra.ts): the cluster, with one `c1.2` node, and the DNS zone the program reads.
- [`src/Api.ts`](./src/Api.ts): the Effect program in the tagged form: the class declares the workload, and `Api.make(props, program)` is the Layer the stack provides.
- [`alchemy.run.ts`](./alchemy.run.ts): the stack, with `Web`, a Deployment from a public image.

## Bindings

| Host | Binding                                       | Access                                                                                                         |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Api  | `Stackit.DNS.GetZone(Domain)` + `GetZoneHttp` | A service account with a key in the container's env. `dns.zone.list` on the project, the narrowest scope STACKIT binds. |

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup).
- Docker running on your machine.
- `IMAGE_REGISTRY`: where the program's image is pushed, such as `ghcr.io/my-org`. Log in to it with `docker login`. The nodes pull with no login, so the images have to be public.

## Cost

About **EUR 0.20 per hour** (price list v1.0.44):

- Cluster management: EUR 0.0996 per started hour, running or hibernated, until deleted.
- One `c1.2` node: EUR 0.0607 per hour, plus its 20 GB volume.
- Two load balancers from the two `LoadBalancer` Services. The list has `p10` at EUR 0.0130 per hour, and a public IP at EUR 0.0041 per hour, each. Check which plan SKE picks.
- The DNS zone: about EUR 0.003 to EUR 0.004 per hour.

STACKIT's Go SDK allows 45 minutes for a cluster to come up and 90 to go down, so plan on two to three started hours for a test run: about EUR 0.60.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-kubernetes
IMAGE_REGISTRY=ghcr.io/my-org pnpm run deploy --profile <name>
```

## Test

```sh
IMAGE_REGISTRY=ghcr.io/my-org ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, reads the cluster through the API, calls both load balancers, then destroys the stack and checks that the cluster is gone.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- The kubeconfig STACKIT returns holds a client certificate or a token. Connecting fails with a typed error if it holds neither.
- Machine type `c1.2` and zone `eu01-1`, with `ListProviderOptions`.

## Destroy

```sh
IMAGE_REGISTRY=ghcr.io/my-org pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
IMAGE_REGISTRY=ghcr.io/my-org pnpm destroy --profile <name> --stage test_$USER
```
