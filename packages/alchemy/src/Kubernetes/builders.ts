/**
 * Zero-runtime typed builders for Kubernetes objects. Each builder fills in
 * `apiVersion`/`kind` and hands back the fully-typed object — nothing more.
 * Use them wherever a Kubernetes-typed value is accepted (e.g.
 * `AWS.EKS.Manifest.manifest`, `AWS.EKS.Deployment.podTemplate`).
 *
 * @example Typed StatefulSet manifest
 * ```typescript
 * const sts = Kubernetes.statefulSet({
 *   metadata: { name: "cache", namespace: "apps" },
 *   spec: {
 *     serviceName: "cache",
 *     replicas: 3,
 *     selector: { matchLabels: { app: "cache" } },
 *     template: {
 *       metadata: { labels: { app: "cache" } },
 *       spec: { containers: [{ name: "redis", image: "redis:7" }] },
 *     },
 *   },
 * });
 * ```
 */
import type * as api from "./api.ts";

export const pod = (input: Omit<api.Pod, "apiVersion" | "kind">): api.Pod => ({
  apiVersion: "v1",
  kind: "Pod",
  ...input,
});

export const deployment = (
  input: Omit<api.Deployment, "apiVersion" | "kind">,
): api.Deployment => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  ...input,
});

export const statefulSet = (
  input: Omit<api.StatefulSet, "apiVersion" | "kind">,
): api.StatefulSet => ({
  apiVersion: "apps/v1",
  kind: "StatefulSet",
  ...input,
});

export const daemonSet = (
  input: Omit<api.DaemonSet, "apiVersion" | "kind">,
): api.DaemonSet => ({
  apiVersion: "apps/v1",
  kind: "DaemonSet",
  ...input,
});

export const job = (input: Omit<api.Job, "apiVersion" | "kind">): api.Job => ({
  apiVersion: "batch/v1",
  kind: "Job",
  ...input,
});

export const cronJob = (
  input: Omit<api.CronJob, "apiVersion" | "kind">,
): api.CronJob => ({
  apiVersion: "batch/v1",
  kind: "CronJob",
  ...input,
});

export const service = (
  input: Omit<api.Service, "apiVersion" | "kind">,
): api.Service => ({
  apiVersion: "v1",
  kind: "Service",
  ...input,
});

export const configMap = (
  input: Omit<api.ConfigMap, "apiVersion" | "kind">,
): api.ConfigMap => ({
  apiVersion: "v1",
  kind: "ConfigMap",
  ...input,
});

export const secret = (
  input: Omit<api.Secret, "apiVersion" | "kind">,
): api.Secret => ({
  apiVersion: "v1",
  kind: "Secret",
  ...input,
});

export const namespace = (
  input: Omit<api.Namespace, "apiVersion" | "kind">,
): api.Namespace => ({
  apiVersion: "v1",
  kind: "Namespace",
  ...input,
});

export const serviceAccount = (
  input: Omit<api.ServiceAccount, "apiVersion" | "kind">,
): api.ServiceAccount => ({
  apiVersion: "v1",
  kind: "ServiceAccount",
  ...input,
});

/**
 * Identity builder for a (deeply partial) pod template. Exists purely for
 * completions at call sites like `AWS.EKS.Deployment.podTemplate`.
 */
export const podTemplate = (
  input: api.DeepPartial<api.PodTemplateSpec>,
): api.DeepPartial<api.PodTemplateSpec> => input;
