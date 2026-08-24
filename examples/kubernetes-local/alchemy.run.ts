import * as Alchemy from "alchemy";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

// Settings shared between the ConfigMap and the Deployment's env.
const settings = {
  LOG_LEVEL: "debug",
  GREETING: "hello from alchemy",
};

// The end state of the Kubernetes tutorial (parts 1–4), on whichever
// cluster your kubeconfig's current context points at: a Namespace,
// a ConfigMap, a Redis StatefulSet + Service, an echo Deployment, a
// one-shot Job, a CronJob, and a Helm chart — all pre-built images,
// so no registry is needed.
export default Alchemy.Stack(
  "KubernetesLocalExample",
  {
    providers: Kubernetes.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // Any cluster `kubectl` can reach. Pass `{ context: "..." }` to pin one.
    const cluster = Kubernetes.KubeConfig();

    const ns = yield* Kubernetes.Manifest("Namespace", {
      cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: "tutorial" },
      },
    });

    const config = yield* Kubernetes.Manifest("Config", {
      cluster,
      manifest: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "app-config", namespace: ns.name },
        data: settings,
      },
    });

    const redis = yield* Kubernetes.Manifest("Redis", {
      cluster,
      manifest: {
        apiVersion: "apps/v1",
        kind: "StatefulSet",
        metadata: { name: "redis", namespace: ns.name },
        spec: {
          serviceName: "redis",
          replicas: 1,
          selector: { matchLabels: { app: "redis" } },
          template: {
            metadata: { labels: { app: "redis" } },
            spec: {
              containers: [
                {
                  name: "redis",
                  image: "redis:7",
                  ports: [{ containerPort: 6379 }],
                },
              ],
            },
          },
        },
      },
    });

    const redisService = yield* Kubernetes.Manifest("RedisService", {
      cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "redis", namespace: ns.name },
        spec: {
          type: "ClusterIP",
          selector: { app: "redis" },
          ports: [{ port: 6379, targetPort: 6379 }],
        },
      },
    });

    // A replicated server from a pre-built image. `LoadBalancer` (the
    // default) populates `url` on clusters with an LB implementation
    // (Docker Desktop, OrbStack); kind/minikube leave it undefined —
    // use NodePort or `kubectl port-forward` there.
    const echo = yield* Kubernetes.Deployment("Echo", {
      cluster,
      namespace: ns.name,
      image: "mendhak/http-https-echo:33",
      port: 8080,
      replicas: 3,
      env: {
        ...settings,
        CONFIG_MAP: config.name,
        REDIS_URL: Output.interpolate`redis://${redisService.name}:6379`,
      },
    });

    // Run-to-completion work.
    const hello = yield* Kubernetes.Job("Hello", {
      cluster,
      namespace: ns.name,
      image: "busybox:1.36",
      command: ["sh", "-c"],
      args: ["echo hello from a Job && sleep 2"],
      backoffLimit: 1,
      ttlSecondsAfterFinished: 300,
    });

    // ...and the same thing on a schedule (a CronJob).
    const tick = yield* Kubernetes.Job("Tick", {
      cluster,
      namespace: ns.name,
      image: "busybox:1.36",
      command: ["sh", "-c", "date"],
      schedule: "*/5 * * * *",
    });

    // A third-party Helm chart, rendered locally and applied as objects.
    const podinfo = yield* Kubernetes.HelmChart("Podinfo", {
      cluster,
      chart: "podinfo",
      repo: "https://stefanprodan.github.io/podinfo",
      version: "6.14.1",
      namespace: "podinfo",
      createNamespace: true,
      values: {
        replicaCount: 2,
        ui: { message: "hello from alchemy" },
      },
    });

    return {
      url: echo.url,
      deployment: echo.deploymentName,
      redis: redis.name,
      job: hello.jobName,
      cron: tick.jobName,
      release: podinfo.releaseName,
    };
  }),
);
