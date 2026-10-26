# Effect API on AKS with Workload ID

A notes API written as an Effect program and run as a `Kubernetes.Deployment`
on an Azure Kubernetes Service (AKS) cluster. Alchemy bundles the program,
pushes it as an image to an Azure Container Registry it creates (no Docker
needed), and applies the Kubernetes Deployment, Service, and ServiceAccount.
A blob binding stores each note in a Storage container and authenticates
with Microsoft Entra Workload ID: no keys, no secrets.

```sh
curl -X PUT "$URL/notes/hello" --data "hi there"
# 201 stored
curl "$URL/notes/hello"
# 200 hi there
```

## Architecture

- [`Cluster`](./src/infra.ts) — `Azure.ContainerService.ManagedCluster` with
  one `Standard_D2s_v7` node on the Free tier, `oidcIssuerEnabled` and
  `workloadIdentityEnabled`. Its `connection` attribute lets you pass the
  cluster itself as a workload's `cluster`.
- [`Notes`](./src/infra.ts) — `Azure.Storage.BlobContainer` in a Storage
  account.
- [`Api`](./src/Api.ts) — `Kubernetes.Deployment` in the tagged form
  (`Api.make(props, impl)`): `main: import.meta.url`, an init Effect that
  binds `Azure.Storage.BlobContainerReadWrite(Notes)`, and a `fetch`
  handler, behind a `LoadBalancer` Service on port 3000.

| Route             | What it does                              |
| ----------------- | ----------------------------------------- |
| `GET /`           | answers `ok`                              |
| `PUT /notes/:key` | stores the body as the blob `notes/<key>` |
| `GET /notes/:key` | returns the note, or `404`                |

Every resource runs in `westus2`. All resources go in the stack's resource
group (`<stack>-<stage>`). The stack needs both provider layers:

```ts
providers: Layer.mergeAll(Azure.providers(), Kubernetes.providers()),
```

## Workload identity

`Azure.providers()` registers the AKS cluster adapter. For a workload whose
bindings ask for Azure roles, it:

1. creates a user-assigned managed identity in the cluster's resource group;
2. federates it with the workload's Kubernetes ServiceAccount
   (`system:serviceaccount:<namespace>:<name>`) through the cluster's OIDC
   issuer;
3. assigns each binding's role to that identity, on the bound resource only
   (here **Storage Blob Data Contributor** on the `Notes` container);
4. annotates the ServiceAccount with the identity's client ID and labels the
   pods `azure.workload.identity/use: "true"`, so the AKS webhook projects a
   token into each pod.

Inside the pod, the program exchanges that token for Entra tokens. Removing a
binding revokes its role on the next deploy; destroying the workload deletes
the identity.

The adapter also gives the cluster's kubelet identity `AcrPull` on the
workload's registry, so the nodes pull the image without a pull secret.

## Cost and time

Well under $1 per run: one `Standard_D2s_v7` node (about $0.10 per hour), the
Free control-plane tier, a Standard load balancer with one public IP, a Basic
registry, and a Standard LRS Storage account. The cluster takes about 6
minutes to create and about 6 minutes to delete, so a full test run takes
about 16 minutes. The test is not gated.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-aks
pnpm deploy --profile <name>
```

The stack outputs the API's URL (`http://<ip>:3000`).

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack and calls the API over HTTP, stores a note and
reads it back through the blob binding. Out of band, it checks that the
ServiceAccount's federated credential names the cluster's OIDC issuer, that
the identity holds exactly one role assignment (Storage Blob Data Contributor
on the container), and that the kubelet holds `AcrPull` on the registry. It
then destroys the stack and checks that the identity, the registry, the
cluster, and the identity's role assignments are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
