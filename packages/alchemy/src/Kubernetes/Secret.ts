import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  toConnection,
  type ClusterLike,
  type Connection,
} from "./Connection.ts";
import {
  applyObject,
  connectCluster,
  deleteObject,
  readObject,
  isNotFound,
} from "./internal/client.ts";
import type { KubernetesObjectRef } from "./internal/objects.ts";
import { encodeSecretData } from "./internal/secret.ts";
import {
  connectionIdentity,
  connectionOfOutput,
  tryConnectionOf,
} from "./internal/workload.ts";
import type { Providers } from "./Providers.ts";

export interface SecretProps {
  /**
   * Target cluster the Secret is applied onto. Pass a managed cluster
   * resource (e.g. `AWS.EKS.Cluster`), a `Kubernetes.KubeConfig(...)`, or
   * a raw `Kubernetes.Connection`. Changing it replaces the Secret.
   */
  cluster: ClusterLike;
  /** Kubernetes Secret name. Changing it replaces the Secret. */
  name: string;
  /**
   * Kubernetes namespace. The namespace must already exist. Changing it
   * replaces the Secret.
   * @default "default"
   */
  namespace?: string;
  /**
   * Kubernetes Secret `type` (e.g. `Opaque`, `kubernetes.io/tls`). Immutable
   * on the API server, so changing it replaces the Secret.
   * @default "Opaque"
   */
  type?: string;
  /** Labels applied to the Secret. */
  labels?: Record<string, string>;
  /** Annotations applied to the Secret. */
  annotations?: Record<string, string>;
  /**
   * Secret values as UTF-8 strings. They stay `Redacted` in plans, logs, and
   * state, and are only unwrapped and base64-encoded while building the
   * Kubernetes API request. State still has to hold the real values so later
   * updates can re-apply them, so point real credentials at an encrypted
   * state backend.
   *
   * A key may appear in `stringData` or `binaryData`, not both.
   */
  stringData?: Record<string, Redacted.Redacted<string>>;
  /**
   * Secret values that are not UTF-8 text (keystores, PKCS#12 bundles, DER
   * certificates), supplied already base64-encoded — the same encoding the
   * Kubernetes `data` field uses. Passed through untouched, so the plaintext
   * bytes never need to exist in state. Keys must not overlap `stringData`.
   */
  binaryData?: Record<string, Redacted.Redacted<string>>;
}

export interface Secret extends Resource<
  "Kubernetes.Secret",
  SecretProps,
  {
    /** The connection of the cluster the Secret is applied to. */
    connection: Connection;
    /** Kubernetes Secret name. */
    name: string;
    /** Kubernetes namespace. */
    namespace: string;
    /** Kubernetes Secret type. */
    type: string;
    /** Reference to the applied Secret. */
    ref: KubernetesObjectRef;
    /** Server-assigned UID, when returned. */
    uid: string | undefined;
  },
  {},
  Providers
> {}

/**
 * A Kubernetes Secret with `Redacted` values. Alchemy never prints the
 * plaintext in plans or logs and never writes it to output attributes. The
 * only place it is unwrapped is the body of the API request. The values do
 * have to live in state so later updates can re-apply them, so use an
 * encrypted backend such as `Cloudflare.state()` for real credentials.
 *
 * ### Creating a Secret
 * **Example:** Create an opaque token Secret
 * ```typescript
 * const connectorToken = yield* Config.redacted("CONNECTOR_TOKEN");
 * const token = yield* Kubernetes.Secret("ConnectorToken", {
 *   cluster,
 *   name: "connector-token",
 *   namespace: "networking",
 *   stringData: {
 *     token: connectorToken,
 *   },
 * });
 * ```
 *
 * ### Binary Values
 * **Example:** Keystore plus its password
 * ```typescript
 * const keystore = yield* fs.readFile("./keystore.jks");
 * const bundle = yield* Kubernetes.Secret("Keystore", {
 *   cluster,
 *   name: "keystore",
 *   binaryData: {
 *     "keystore.jks": Redacted.make(Buffer.from(keystore).toString("base64")),
 *   },
 *   stringData: {
 *     "keystore-password": yield* Config.redacted("KEYSTORE_PASSWORD"),
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Secret = Resource<Secret>("Kubernetes.Secret");

export { SecretDataKeyConflict } from "./internal/secret.ts";

export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      return {
        stables: ["connection", "name", "namespace", "type"],
        // In-cluster objects have no cloud-side enumeration that attributes
        // them to alchemy; refresh happens per-instance through `read`.
        list: () => Effect.succeed([] as Secret["Attributes"][]),
        diff: Effect.fn(function* ({ olds = {} as SecretProps, news }) {
          if (!isResolved(news)) return;
          // Surface a stringData/binaryData key collision at plan time
          // rather than mid-apply.
          yield* encodeSecretData(news);
          const oldCluster = connectionIdentity(tryConnectionOf(olds.cluster));
          const newCluster = connectionIdentity(tryConnectionOf(news.cluster));
          // Object identity (cluster, name, namespace) and `type` are
          // immutable — changing any of them is a replacement.
          if (
            olds.name !== undefined &&
            ((oldCluster !== undefined &&
              newCluster !== undefined &&
              oldCluster !== newCluster) ||
              olds.name !== news.name ||
              (olds.namespace ?? "default") !== (news.namespace ?? "default") ||
              (olds.type ?? "Opaque") !== (news.type ?? "Opaque"))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const connection = connectionOfOutput(output);
          if (!connection) return undefined;
          const transport = yield* connectCluster(connection).pipe(
            // Cluster gone — its objects went with it.
            Effect.catchTag("Kubernetes.ClusterNotFoundError", () =>
              Effect.succeed(undefined),
            ),
          );
          if (!transport) return undefined;
          const observed = yield* readObject({
            transport,
            object: output.ref,
          }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!observed) return undefined;
          const object = observed as {
            metadata?: { uid?: string };
            type?: string;
          };
          return {
            ...output,
            type: object.type ?? output.type,
            uid: object.metadata?.uid ?? output.uid,
          };
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const connection = toConnection(news.cluster);
          const transport = yield* connectCluster(connection);
          const namespace = news.namespace ?? "default";
          const type = news.type ?? "Opaque";
          const ref: KubernetesObjectRef = {
            apiVersion: "v1",
            kind: "Secret",
            name: news.name,
            namespace,
          };
          // Server-side apply is a true upsert: create-if-missing and
          // converge-if-present in one call, `force: true` so alchemy owns
          // the fields it manages regardless of prior managers.
          const applied = yield* applyObject({
            transport,
            object: {
              apiVersion: "v1",
              kind: "Secret",
              metadata: {
                name: news.name,
                namespace,
                labels: news.labels,
                annotations: news.annotations,
              },
              type,
              data: yield* encodeSecretData(news),
            },
          });
          yield* session.note(`Applied v1/Secret ${namespace}/${news.name}`);
          const uid =
            (applied as { metadata?: { uid?: string } })?.metadata?.uid ??
            output?.uid;
          return { connection, name: news.name, namespace, type, ref, uid };
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = connectionOfOutput(output);
          if (!connection) return;
          const transport = yield* connectCluster(connection).pipe(
            // Cluster already destroyed — nothing left to delete.
            Effect.catchTag("Kubernetes.ClusterNotFoundError", () =>
              Effect.succeed(undefined),
            ),
          );
          if (!transport) return;
          yield* deleteObject({ transport, object: output.ref }).pipe(
            // Tolerate any residual API failure so delete stays idempotent
            // (e.g. the namespace is already terminating).
            Effect.catch(() => Effect.void),
          );
        }),
      };
    }),
  );
