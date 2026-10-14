import type * as rolldown from "rolldown";
import type { ResourceLike } from "../Resource.ts";
import type { Function } from "./Lambda/Function.ts";

/**
 * A native AWS host: code on it runs as an IAM role (Lambda execution role,
 * ECS task role, EC2 instance profile, …), so bindings grant on that role and
 * sign with its ambient credentials. Every native host accepts the
 * `{ env, policyStatements }` binding contract of {@link Function}.
 */
export type NativeHost = Function;

/**
 * The AWS platforms whose code runs as an IAM role. Not a Lambda
 * `MicrovmImage`: an image has no role of its own (`RunMicrovm` takes one per
 * launch), so AWS bindings inside a MicroVM reach AWS as an external host.
 */
const NATIVE_HOST_TYPES = new Set([
  "AWS.Lambda.Function",
  "AWS.Lambda.WebFunction",
  "AWS.ECS.Task",
  "AWS.ECS.Service",
  "AWS.EC2.Instance",
  "AWS.AutoScaling.LaunchTemplate",
  "AWS.AppRunner.Service",
  "AWS.Batch.JobDefinition",
]);

/** The Kubernetes workloads, native only on an EKS cluster. */
const KUBERNETES_WORKLOAD_TYPES = new Set(["Kubernetes.Deployment", "Kubernetes.Job"]);

/**
 * The env var marking a host's runtime as native to a cloud, e.g. `"AWS"` in
 * an EKS pod. The runtime counterpart of `__ALCHEMY_NATIVE_HOST__`, for hosts
 * whose cloud depends on where they're deployed rather than their type.
 */
export const NATIVE_HOST_ENV = "ALCHEMY_NATIVE_HOST";

/**
 * Whether a binding's host is a native AWS host: an AWS platform whose code
 * runs as an IAM role (Lambda, ECS, EC2, AutoScaling, AppRunner,
 * Batch), or a Kubernetes workload on an EKS cluster, whose grants go to the
 * cluster adapter (EKS Pod Identity). Every other host is external: a
 * Cloudflare Worker, Cloud Run, or a Kubernetes workload on GKE, a local
 * cluster or any kubeconfig.
 */
export const isNativeHost = (host: ResourceLike | undefined): host is NativeHost =>
  host !== undefined &&
  (NATIVE_HOST_TYPES.has(host.Type) ||
    (KUBERNETES_WORKLOAD_TYPES.has(host.Type) && runsOnEks(host)));

/**
 * Whether a Kubernetes workload runs on an EKS cluster.
 *
 * At deploy, its `cluster` prop holds the resolved cluster: the
 * `AWS.EKS.Cluster` resource, or a connection authenticating as `aws-eks`.
 * At runtime the pod doesn't know its cluster, so the EKS adapter sets
 * {@link NATIVE_HOST_ENV} to `"AWS"` in the pod's env.
 */
const runsOnEks = (host: ResourceLike): boolean => {
  if (globalThis.__ALCHEMY_RUNTIME__) {
    return globalThis.process?.env?.[NATIVE_HOST_ENV] === "AWS";
  }
  const cluster: unknown = (host as { Props?: { cluster?: unknown } }).Props?.cluster;
  // A `Cluster.ref(...)` is a callable Output proxy, so accept functions too.
  if ((typeof cluster !== "object" && typeof cluster !== "function") || cluster === null) {
    return false;
  }
  if ("Type" in cluster && typeof cluster.Type === "string") {
    return cluster.Type.startsWith("AWS.EKS.");
  }
  const connection: unknown = "connection" in cluster ? cluster.connection : cluster;
  const auth: unknown =
    typeof connection === "object" && connection !== null && "auth" in connection
      ? connection.auth
      : undefined;
  return typeof auth === "object" && auth !== null && "kind" in auth && auth.kind === "aws-eks";
};

/**
 * Fold `__ALCHEMY_NATIVE_HOST__` to `"AWS"` into a bundle that runs on a
 * native AWS host, so AWS bindings drop their external-host code paths
 * (see `HostAccess.withCredentials`).
 */
export const nativeHostBundle = (input: rolldown.InputOptions): rolldown.InputOptions => ({
  ...input,
  transform: {
    ...input.transform,
    define: {
      ...input.transform?.define,
      "globalThis.__ALCHEMY_NATIVE_HOST__": JSON.stringify("AWS"),
    },
  },
});
