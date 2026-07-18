import * as eks from "@distilled.cloud/aws/eks";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Cluster } from "./Cluster.ts";
import type * as Kubernetes from "../../Kubernetes/index.ts";
import {
  applyObject,
  deleteObject,
  readObject,
  KubernetesApiError,
  type KubernetesClusterConnection,
} from "./internal/client.ts";
import type {
  KubernetesObjectDefinition,
  KubernetesObjectRef,
} from "./internal/objects.ts";

/**
 * The subset of an `AWS.EKS.Cluster`'s Attributes the Manifest needs to
 * connect to the Kubernetes API. Pass the whole cluster resource — the engine
 * resolves it to bare attributes at reconcile.
 */
type ClusterConnectionProps = Pick<
  Cluster["Attributes"],
  "clusterName" | "endpoint" | "certificateAuthorityData"
>;

export interface ManifestProps {
  /**
   * Target EKS cluster the manifest is applied onto. Pass the
   * `AWS.EKS.Cluster` resource; the Manifest reads its `endpoint` /
   * `certificateAuthorityData` to reach the Kubernetes API.
   */
  cluster: ClusterConnectionProps;
  /**
   * The Kubernetes object to apply (server-side apply, field manager
   * `alchemy`). Use the typed builders from `alchemy/Kubernetes`
   * (`Kubernetes.statefulSet({...})`, `Kubernetes.configMap({...})`, …) for
   * completions, or pass any raw object — arbitrary CRDs are supported via
   * API discovery.
   */
  manifest: Kubernetes.Manifest;
}

export interface Manifest extends Resource<
  "AWS.EKS.Manifest",
  ManifestProps,
  {
    /** The name of the EKS cluster the object is applied to. */
    clusterName: string;
    /** The Kubernetes API version of the applied object. */
    apiVersion: string;
    /** The Kubernetes kind of the applied object. */
    kind: string;
    /** The name of the applied object. */
    name: string;
    /** The namespace of the applied object (`undefined` for cluster-scoped kinds). */
    namespace: string | undefined;
    /** Reference to the applied Kubernetes object. */
    ref: KubernetesObjectRef;
    /** The server-assigned UID of the applied object, when returned. */
    uid: string | undefined;
  },
  {},
  Providers
> {}

/**
 * Applies a raw Kubernetes manifest onto an `AWS.EKS.Cluster` via
 * server-side apply.
 *
 * Any object is accepted: the kinds modeled by the opt-in `alchemy/Kubernetes`
 * types (with full completions through the zero-runtime builders) or untyped
 * custom resources — unknown kinds are resolved through the Kubernetes API
 * discovery endpoint, so CRDs work without any registration.
 * @resource
 * @section Applying Manifests
 * @example Typed StatefulSet via the Kubernetes builders
 * ```typescript
 * import * as Kubernetes from "alchemy/Kubernetes";
 *
 * const sts = yield* AWS.EKS.Manifest("Cache", {
 *   cluster,
 *   manifest: Kubernetes.statefulSet({
 *     metadata: { name: "cache", namespace: "apps" },
 *     spec: {
 *       serviceName: "cache",
 *       replicas: 3,
 *       selector: { matchLabels: { app: "cache" } },
 *       template: {
 *         metadata: { labels: { app: "cache" } },
 *         spec: { containers: [{ name: "redis", image: "redis:7" }] },
 *       },
 *     },
 *   }),
 * });
 * ```
 *
 * @example Untyped custom resource (CRD)
 * ```typescript
 * const widget = yield* AWS.EKS.Manifest("Widget", {
 *   cluster,
 *   manifest: {
 *     apiVersion: "acme.io/v1",
 *     kind: "Widget",
 *     metadata: { name: "w", namespace: "default" },
 *     spec: { size: 3 },
 *   },
 * });
 * ```
 *
 * @section Namespaces
 * @example Create a Namespace
 * ```typescript
 * const ns = yield* AWS.EKS.Manifest("AppsNamespace", {
 *   cluster,
 *   manifest: Kubernetes.namespace({ metadata: { name: "apps" } }),
 * });
 * ```
 */
export const Manifest = Resource<Manifest>("AWS.EKS.Manifest");

const toConnection = (
  cluster: ClusterConnectionProps,
): KubernetesClusterConnection => {
  if (!cluster.endpoint || !cluster.certificateAuthorityData) {
    throw new Error(
      `EKS cluster '${cluster.clusterName}' is missing endpoint or certificate authority data`,
    );
  }
  return {
    clusterName: cluster.clusterName,
    endpoint: cluster.endpoint,
    certificateAuthorityData: cluster.certificateAuthorityData,
  };
};

const toObjectDefinition = (
  manifest: Kubernetes.Manifest,
): Effect.Effect<KubernetesObjectDefinition, Error> => {
  const name = manifest.metadata?.name;
  if (!name) {
    return Effect.fail(
      new Error(
        `AWS.EKS.Manifest requires manifest.metadata.name (got ${manifest.apiVersion}/${manifest.kind})`,
      ),
    );
  }
  return Effect.succeed(manifest as KubernetesObjectDefinition);
};

// Re-resolve a Kubernetes connection from the cluster name alone (used by
// read/delete, whose persisted attributes don't cache the endpoint/CA).
const describeConnection = Effect.fn(function* (clusterName: string) {
  const described = yield* eks
    .describeCluster({ name: clusterName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  const cluster = described?.cluster;
  if (!cluster?.endpoint || !cluster.certificateAuthority?.data) {
    return undefined;
  }
  return {
    clusterName,
    endpoint: cluster.endpoint,
    certificateAuthorityData: cluster.certificateAuthority.data,
  } satisfies KubernetesClusterConnection;
});

const isNotFound = (error: unknown): error is KubernetesApiError =>
  error instanceof KubernetesApiError && error.statusCode === 404;

export const ManifestProvider = () =>
  Provider.effect(
    Manifest,
    Effect.gen(function* () {
      return {
        stables: ["clusterName", "apiVersion", "kind", "name", "namespace"],
        // In-cluster objects have no AWS-side enumeration that attributes
        // them to alchemy; refresh happens per-instance through `read`.
        list: () => Effect.succeed([] as Manifest["Attributes"][]),
        diff: Effect.fn(function* ({ olds = {} as ManifestProps, news }) {
          if (!isResolved(news)) return;
          const oldManifest = olds.manifest as
            | Kubernetes.CustomManifest
            | undefined;
          const newManifest = news.manifest as Kubernetes.CustomManifest;
          // Object identity (cluster, group/version/kind, name, namespace) is
          // immutable — changing any of it is a replacement.
          if (
            oldManifest &&
            (olds.cluster?.clusterName !== news.cluster?.clusterName ||
              oldManifest.apiVersion !== newManifest.apiVersion ||
              oldManifest.kind !== newManifest.kind ||
              oldManifest.metadata?.name !== newManifest.metadata?.name ||
              oldManifest.metadata?.namespace !==
                newManifest.metadata?.namespace)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const connection = yield* describeConnection(output.clusterName);
          // Cluster gone — its objects went with it.
          if (!connection) return undefined;
          const observed = yield* readObject({
            connection,
            object: output.ref,
          }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!observed) return undefined;
          const uid = (observed as { metadata?: { uid?: string } }).metadata
            ?.uid;
          return { ...output, uid };
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const connection = toConnection(news.cluster);
          const object = yield* toObjectDefinition(news.manifest);
          const ref: KubernetesObjectRef = {
            apiVersion: object.apiVersion,
            kind: object.kind,
            name: object.metadata.name,
            namespace: object.metadata.namespace,
          };

          // Server-side apply is a true upsert: create-if-missing and
          // converge-if-present in one call, `force: true` so alchemy owns
          // the fields it manages regardless of prior managers.
          const applied = yield* applyObject({ connection, object });

          yield* session.note(
            `Applied ${ref.apiVersion}/${ref.kind} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`,
          );

          const uid =
            (applied as { metadata?: { uid?: string } })?.metadata?.uid ??
            output?.uid;

          return {
            clusterName: connection.clusterName,
            apiVersion: ref.apiVersion,
            kind: ref.kind,
            name: ref.name,
            namespace: ref.namespace,
            ref,
            uid,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = yield* describeConnection(output.clusterName);
          // Cluster already destroyed — nothing left to delete.
          if (!connection) return;
          yield* deleteObject({ connection, object: output.ref }).pipe(
            // Tolerate any residual API failure so delete stays idempotent
            // (e.g. the CRD backing an object was removed before the object).
            Effect.catch(() => Effect.void),
          );
        }),
      };
    }),
  );
