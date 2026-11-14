import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { isPlainObject } from "alchemy/Util/data";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  applyObject,
  connectCluster,
  deleteObject,
  ifClusterExists,
  readObject,
  retryWhileClusterWarms,
} from "./Client.ts";
import { toConnection, type ClusterLike, type Connection } from "./Connection.ts";
import { driftMask, hashDriftSelection } from "./internal/declared.ts";
import { connectionIdentity, connectionOfOutput, tryConnectionOf } from "./internal/workload.ts";
import type { KubernetesObjectDefinition, KubernetesObjectRef } from "./Objects.ts";
import type { Providers } from "./Providers.ts";

/** `stringData` and `data` share a key, or a `data` value is not base64. */
export class SecretInvalidProps extends Data.TaggedError("SecretInvalidProps")<{
  readonly message: string;
}> {}

/**
 * The live Secret has a controller owner, such as an External Secrets
 * `ExternalSecret` or a `SealedSecret`. That controller would write its own
 * values back after Alchemy applied, so Alchemy refuses instead.
 */
export class SecretControlledByOwner extends Data.TaggedError("SecretControlledByOwner")<{
  readonly namespace: string;
  readonly secretName: string;
  readonly owner: { apiVersion: string; kind: string; name: string };
}> {
  override get message(): string {
    return `Secret ${this.namespace}/${this.secretName} is controlled by ${this.owner.apiVersion}/${this.owner.kind} ${this.owner.name}; release it from that controller or choose another name`;
  }
}

export interface SecretProps {
  /**
   * Target cluster. Pass a managed cluster resource (e.g. `AWS.EKS.Cluster`),
   * a `Kubernetes.KubeConfig(...)`, or a raw `Kubernetes.Connection`.
   * Changing it replaces the Secret.
   */
  cluster: ClusterLike;
  /**
   * Secret name. Changing it replaces the Secret.
   * @default a unique name generated from the app, stage and logical ID
   */
  name?: string;
  /**
   * Namespace. It must already exist. Changing it replaces the Secret.
   * @default "default"
   */
  namespace?: string;
  /**
   * Secret `type`, e.g. `Opaque`, `kubernetes.io/tls` or
   * `kubernetes.io/dockerconfigjson`. The API server never changes the type
   * of an existing Secret, so changing it replaces the Secret. With an
   * explicit `name`, the old Secret is deleted before the new one is created.
   * @default "Opaque"
   */
  type?: string;
  /** Labels on the Secret. */
  labels?: Record<string, string>;
  /** Annotations on the Secret. */
  annotations?: Record<string, string>;
  /**
   * Values as UTF-8 strings. They must be `Redacted`, so plans and logs show
   * `<redacted>`. Alchemy base64-encodes them into the Secret's `data`
   * when it sends the request. Keys must not also appear in `data`.
   */
  stringData?: Record<string, Redacted.Redacted<string>>;
  /**
   * Values that are not UTF-8 text (keystores, PKCS#12 bundles, DER
   * certificates), already base64-encoded as the Kubernetes `data` field
   * expects. Values must be standard padded base64; line breaks are
   * removed. Keys must not also appear in `stringData`.
   */
  data?: Record<string, Redacted.Redacted<string>>;
}

export interface Secret extends Resource<
  "Kubernetes.Secret",
  SecretProps,
  {
    /** The connection of the cluster the Secret is applied to. */
    connection: Connection;
    /** Secret name. */
    name: string;
    /** Namespace. */
    namespace: string;
    /** Secret type. */
    type: string;
    /** Reference to the applied Secret. */
    ref: KubernetesObjectRef;
    /** Server-assigned UID, when returned. */
    uid: string | undefined;
    /** Fingerprint of the declared fields last applied, for `alchemy drift`. */
    baselineHash?: string;
    /** Declared-field mask from the last apply, for `alchemy drift`. */
    driftMask?: unknown;
    /** Set by `read` when the live Secret diverges from the last apply. */
    observedHash?: string;
  },
  {},
  Providers
> {}

/**
 * A Kubernetes Secret whose values are `Redacted` by type, so a plaintext
 * string can't reach a plan, a log or an output attribute. Values are
 * unwrapped only in the body of the API request, and error responses are
 * scrubbed of them.
 *
 * Use it instead of a `Kubernetes.Manifest` with `kind: "Secret"`:
 *
 * - **Removed keys are deleted.** `stringData` is encoded into `data`
 *   before the apply. Server-side apply never prunes a key that was sent as
 *   `stringData`, so with a Manifest a removed key stays in the cluster.
 * - **Changing `type` works.** The API server rejects a type change, so
 *   Alchemy replaces the Secret instead.
 * - **Controller-owned Secrets are refused.** If the live Secret has a
 *   controller owner, such as an External Secrets `ExternalSecret` or a
 *   `SealedSecret`, the deploy fails rather than fighting that controller.
 *
 * State still holds the values, so a later deploy can apply them again.
 * For real credentials, use a state store that encrypts them, such as
 * `Cloudflare.state()`.
 *
 * ### Creating a Secret
 * **Example:** Token from configuration
 * ```typescript
 * const token = yield* Kubernetes.Secret("ConnectorToken", {
 *   cluster,
 *   name: "connector-token",
 *   namespace: "networking",
 *   stringData: {
 *     token: yield* Config.Redacted("CONNECTOR_TOKEN"),
 *   },
 * });
 * ```
 *
 * **Example:** Generated database password
 * ```typescript
 * const password = yield* Alchemy.makeRandom("DbPassword", { bytes: 16 });
 *
 * const db = yield* Kubernetes.Secret("DbCredentials", {
 *   cluster,
 *   namespace: "apps",
 *   stringData: { username: Redacted.make("app"), password },
 * });
 * ```
 *
 * ### Binary values
 * **Example:** Keystore plus its password
 * ```typescript
 * const keystore = yield* fs.readFile("./keystore.jks");
 *
 * const bundle = yield* Kubernetes.Secret("Keystore", {
 *   cluster,
 *   data: {
 *     "keystore.jks": Redacted.make(Buffer.from(keystore).toString("base64")),
 *   },
 *   stringData: {
 *     "keystore-password": yield* Config.Redacted("KEYSTORE_PASSWORD"),
 *   },
 * });
 * ```
 *
 * ### Using a Secret
 * **Example:** Pass it to a Helm chart as an existing Secret
 * ```typescript
 * yield* Kubernetes.HelmChart("Postgres", {
 *   cluster,
 *   chart: "oci://registry-1.docker.io/bitnamicharts/postgresql",
 *   namespace: "apps",
 *   values: { auth: { existingSecret: db.name } },
 * });
 * ```
 *
 * @resource
 * @product Secret
 */
export const Secret = Resource<Secret>("Kubernetes.Secret");

type SecretValues = Pick<SecretProps, "stringData" | "data">;

// Go's StdEncoding, which the API server decodes `data` with.
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Merge `stringData` (base64-encoded here) and `data` into the wire `data`
 * map. Values stay `Redacted`; the client unwraps them in the request body.
 */
const encodeSecretData = ({ stringData = {}, data = {} }: SecretValues) =>
  Effect.gen(function* () {
    const shared = Object.keys(stringData).filter((key) => Object.hasOwn(data, key));
    if (shared.length > 0) {
      return yield* new SecretInvalidProps({
        message: `Kubernetes.Secret keys must appear in only one of stringData and data: ${shared.join(", ")}`,
      });
    }
    const { encoded, invalid } = yield* Effect.sync(() => {
      const encoded: Record<string, Redacted.Redacted<string>> = {};
      const invalid: string[] = [];
      for (const [key, value] of Object.entries(data)) {
        const unwrapped = Redacted.value(value).replace(/[\r\n]/g, "");
        if (base64Pattern.test(unwrapped)) encoded[key] = Redacted.make(unwrapped);
        else invalid.push(key);
      }
      for (const [key, value] of Object.entries(stringData)) {
        encoded[key] = Redacted.make(Buffer.from(Redacted.value(value), "utf8").toString("base64"));
      }
      return { encoded, invalid };
    });
    if (invalid.length > 0) {
      // Report the keys only, never the values.
      return yield* new SecretInvalidProps({
        message: `Kubernetes.Secret data values must be standard padded base64: ${invalid.join(", ")}`,
      });
    }
    return encoded;
  });

/**
 * Plaintext `stringData` values. The request only carries their base64
 * form, which the client already scrubs; these cover an echo of the decoded
 * value, e.g. from an admission webhook.
 */
const plaintextValues = ({ stringData = {} }: SecretValues) =>
  Effect.sync(() => Object.values(stringData).map((value) => Redacted.value(value)));

interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  controller?: boolean;
}

/** Fails when the observed Secret has a controller owner. */
const ensureNotControlled = (namespace: string, secretName: string, observed: unknown) => {
  const live = observed as { metadata?: { ownerReferences?: OwnerReference[] } } | undefined;
  const owner = live?.metadata?.ownerReferences?.find((candidate) => candidate.controller === true);
  return owner
    ? Effect.fail(
        new SecretControlledByOwner({
          namespace,
          secretName,
          owner: { apiVersion: owner.apiVersion, kind: owner.kind, name: owner.name },
        }),
      )
    : Effect.void;
};

export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      return {
        stables: ["connection", "name", "namespace", "type"],
        // In-cluster objects have no cloud-side enumeration that attributes
        // them to alchemy; refresh happens per-instance through `read`.
        list: () => Effect.succeed([] as Secret["Attributes"][]),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          // A key collision or bad base64 fails the plan, not the apply.
          yield* encodeSecretData(news);
          if (olds === undefined) return;
          const oldCluster = connectionIdentity(tryConnectionOf(olds.cluster));
          const newCluster = connectionIdentity(tryConnectionOf(news.cluster));
          if (
            (oldCluster !== undefined && newCluster !== undefined && oldCluster !== newCluster) ||
            olds.name !== news.name ||
            (olds.namespace ?? "default") !== (news.namespace ?? "default")
          ) {
            return { action: "replace" } as const;
          }
          // `type` is immutable. A replacement with an explicit name reuses
          // it, so the old Secret has to be gone first; a generated name is
          // new, so the replacement is created before the old one is deleted.
          if ((olds.type ?? "Opaque") !== (news.type ?? "Opaque")) {
            return { action: "replace", deleteFirst: news.name !== undefined } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const connection = connectionOfOutput(output);
          if (!connection) return undefined;
          const transport = yield* connectCluster(connection);
          const observed = yield* readObject({ transport, object: output.ref }).pipe(
            Effect.catchTag("KubernetesNotFound", () => Effect.undefined),
          );
          if (!observed) return undefined;
          const live = observed as { metadata?: { uid?: string }; type?: string };
          const attrs = {
            ...output,
            type: live.type ?? output.type,
            uid: live.metadata?.uid ?? output.uid,
          };
          if (output.driftMask === undefined || output.baselineHash === undefined) return attrs;
          const liveHash = yield* hashDriftSelection(output.driftMask, observed);
          return liveHash === output.baselineHash ? attrs : { ...attrs, observedHash: liveHash };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const connection = toConnection(news.cluster);
          const transport = yield* connectCluster(connection);
          const name =
            news.name ??
            output?.name ??
            (yield* createPhysicalName({ id, maxLength: 63, lowercase: true })).replaceAll(
              /[^a-z0-9-]/g,
              "-",
            );
          const namespace = news.namespace ?? "default";
          const type = news.type ?? "Opaque";
          const ref: KubernetesObjectRef = { apiVersion: "v1", kind: "Secret", name, namespace };
          const data = yield* encodeSecretData(news);

          // A forced apply would take the fields from a controller that
          // writes them back on its next sync. Refuse instead.
          const observed = yield* readObject({ transport, object: ref }).pipe(
            retryWhileClusterWarms,
            Effect.catchTag("KubernetesNotFound", () => Effect.undefined),
          );
          yield* ensureNotControlled(namespace, name, observed);

          const object: KubernetesObjectDefinition = {
            apiVersion: "v1",
            kind: "Secret",
            metadata: {
              name,
              namespace,
              // Omitted, not `undefined`: a declared field is compared for drift.
              ...(news.labels ? { labels: news.labels } : {}),
              ...(news.annotations ? { annotations: news.annotations } : {}),
            },
            type,
            data,
          };
          // Server-side apply creates or converges in one call. Sending
          // `data` (not `stringData`) makes Alchemy the owner of each key,
          // so a key removed from props is removed from the Secret.
          const applied = yield* applyObject({
            transport,
            object,
            redactions: yield* plaintextValues(news),
          });
          const witnessed = isPlainObject(applied) ? applied : undefined;
          yield* session.note(`Applied v1/Secret ${namespace}/${name}`);

          return {
            connection,
            name,
            namespace,
            type,
            ref,
            uid: (witnessed?.metadata as { uid?: string } | undefined)?.uid ?? output?.uid,
            baselineHash: yield* hashDriftSelection(object, witnessed ?? object),
            driftMask: driftMask(object, witnessed),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = connectionOfOutput(output);
          if (!connection) return;
          const transport = yield* ifClusterExists(connectCluster(connection));
          if (!transport) return;
          // 404 is already success; 403/5xx surface, the Secret is still there.
          yield* deleteObject({ transport, object: output.ref });
        }),
      };
    }),
  );
