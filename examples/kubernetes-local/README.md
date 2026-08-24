# Kubernetes (local cluster) Example

The end state of the [Kubernetes tutorial](https://alchemy.run/kubernetes/tutorial/part-1)
on any cluster your kubeconfig can reach — Docker Desktop, OrbStack, kind, k3s — with
no cloud account and no container registry:

- a `tutorial` Namespace, an `app-config` ConfigMap, and a Redis StatefulSet + Service,
  all as `Kubernetes.Manifest`
- an echo server as a `Kubernetes.Deployment` (pre-built `image:`), wired to the
  ConfigMap and Redis through `env`
- a one-shot `Kubernetes.Job` and a `Kubernetes.Job` with `schedule` (a CronJob)
- the `podinfo` Helm chart as a `Kubernetes.HelmChart`, rendered with the local
  `helm` CLI and applied as objects

## Commands

```sh
bun install
bun run --filter kubernetes-local-example deploy
bun run --filter kubernetes-local-example destroy
```

`alchemy.run.ts` uses your kubeconfig's current context; pass
`Kubernetes.KubeConfig({ context: "docker-desktop" })` to pin one. `helm` must be
installed for the chart.

## Try it

```sh
# Docker Desktop / OrbStack publish the LoadBalancer on localhost:
curl "$url/hello"

# kind / minikube have no LoadBalancer controller — port-forward instead:
kubectl -n tutorial port-forward "svc/$deployment" 8080:8080 &
curl localhost:8080/hello
```
