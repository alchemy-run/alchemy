import * as Schema from "effect/Schema";
import type * as rolldown from "rolldown";
import { NATIVE_HOST_ENV, nativeHostBundle as coreNativeHostBundle } from "../NativeHost.ts";
import { isResourceOfType, type Resource, type ResourceLike } from "../Resource.ts";
import type { GcpHostBinding } from "./Host.ts";

/**
 * A native GCP host: code on it runs as a service account (the Cloud Run or
 * Cloud Functions runtime account, or a GKE Workload Identity principal), so
 * bindings grant on that identity and sign with its metadata-server token.
 */
export type NativeHost = Resource<string, object, object, GcpHostBinding>;

/** The GCP platforms whose code runs as a service account. */
const NATIVE_HOST_TYPES = new Set([
  "GCP.Run.Service",
  "GCP.Run.Job",
  "GCP.Run.WorkerPool",
  "GCP.CloudFunctions.Function",
]);

/** The Kubernetes workloads, native only on a GKE cluster. */
const KUBERNETES_WORKLOAD_TYPES = new Set(["Kubernetes.Deployment", "Kubernetes.Job"]);

/**
 * Whether a binding's host is a native GCP host: Cloud Run, Cloud Functions,
 * or a Kubernetes workload on a GKE cluster, whose grants go to the cluster
 * adapter (Workload Identity). Every other host is external: a Cloudflare
 * Worker, an AWS Lambda, or a Kubernetes workload on EKS, a local cluster or
 * any kubeconfig.
 */
export const isNativeHost = (host: ResourceLike | undefined): host is NativeHost =>
  host !== undefined &&
  (NATIVE_HOST_TYPES.has(host.Type) ||
    (KUBERNETES_WORKLOAD_TYPES.has(host.Type) && runsOnGke(host)));

const GkeAuth = Schema.Struct({ auth: Schema.Struct({ kind: Schema.Literal("gcp-gke") }) });

/** A `Kubernetes.ClusterLike` authenticating as `gcp-gke`: a connection or a value wrapping one. */
const isGkeConnection = Schema.is(Schema.Union([GkeAuth, Schema.Struct({ connection: GkeAuth })]));

/**
 * Whether a Kubernetes workload runs on a GKE cluster.
 *
 * At deploy, its `cluster` prop holds the resolved cluster: the
 * `GCP.Container.Cluster` resource, or a connection authenticating as
 * `gcp-gke`. At runtime the pod doesn't know its cluster, so the GKE adapter
 * sets {@link NATIVE_HOST_ENV} to `"GCP"` in the pod's env.
 */
const runsOnGke = (host: ResourceLike): boolean =>
  globalThis.__ALCHEMY_RUNTIME__
    ? globalThis.process?.env?.[NATIVE_HOST_ENV] === "GCP"
    : isResourceOfType(host.Props?.cluster, "GCP.Container.Cluster") ||
      isGkeConnection(host.Props?.cluster);

/**
 * Fold `__ALCHEMY_NATIVE_HOST__` to `"GCP"` into a bundle that runs on a
 * native GCP host, so GCP bindings drop their external-host code paths
 * (see `GCPBindings.withCredentials`).
 */
export const nativeHostBundle = (input: rolldown.InputOptions): rolldown.InputOptions =>
  coreNativeHostBundle("GCP", input);
