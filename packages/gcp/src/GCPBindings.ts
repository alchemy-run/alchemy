import { Credentials, fromServiceAccountKey } from "@distilled.cloud/gcp/Credentials";
import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { isResourceOfType, type ResourceLike } from "alchemy/Resource";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as rolldown from "rolldown";
import type { GcpIamGrant } from "./Host.ts";
import { ServiceAccount } from "./IAM/ServiceAccount.ts";
import { ServiceAccountKey } from "./IAM/ServiceAccountKey.ts";

/**
 * How a GCP binding reaches GCP from its host:
 *
 * - the host runs as a service account (Cloud Run, Cloud Functions, a GKE
 *   pod): roles are granted to that account, and calls use its
 *   metadata-server credentials;
 * - any other host (a Cloudflare Worker, an AWS Lambda, an EKS pod): Alchemy
 *   creates a service account and key for it, grants the roles to that
 *   account, and binds the key into the host's env;
 * - no host (a script or deploy-time Action): nothing is bound and calls use
 *   the deployer's credentials.
 *
 * Import it as a namespace. A binding resolves its operations with
 * {@link withCredentials} and gets its `bind` from {@link Bind} when its layer
 * is built, then binds behind its own `__ALCHEMY_RUNTIME__` guard:
 *
 * ```ts
 * Effect.gen(function* () {
 *   const publish = yield* GCPBindings.withCredentials(pubsub.publishProjectsTopics);
 *   const bind = yield* GCPBindings.Bind;
 *   return Effect.fn(function* (topic: Topic) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`GCP.PubSub.WriteTopic(${topic})`({
 *         iam: [{ role: "roles/pubsub.publisher", resource: { kind: "pubsub.topic", name: topic.name } }],
 *       });
 *     }
 *     return (message) => publish({ topic: …, body: … });
 *   });
 * })
 * ```
 */

/** What a GCP binding attaches to its host. */
export interface HostBinding {
  /** The IAM roles the binding needs. */
  readonly iam?: Input<GcpIamGrant>[];
  /** Env vars the binding reads at runtime. */
  readonly env?: Record<string, unknown>;
}

/**
 * Build options for a bundle that runs on a host running as a GCP service account (Cloud Run, Cloud Functions, GKE): defines
 * `__ALCHEMY_HOST_IDENTITY__` as `"GCP.IAM.ServiceAccount"` so the bundler drops the created-key credentials path.
 */
export const serviceAccountHostBundle = (input: rolldown.InputOptions): rolldown.InputOptions => ({
  ...input,
  transform: {
    ...input.transform,
    define: {
      ...input.transform?.define,
      "globalThis.__ALCHEMY_HOST_IDENTITY__": JSON.stringify("GCP.IAM.ServiceAccount"),
    },
  },
});

/**
 * Env vars holding the key Alchemy creates for a host that doesn't run as a
 * service account. Only {@link Bind} sets them, and only on that path, so
 * at runtime their presence is the whole decision.
 */
const KEY_ENV = {
  email: "ALCHEMY_GCP_SERVICE_ACCOUNT_EMAIL",
  project: "ALCHEMY_GCP_SERVICE_ACCOUNT_PROJECT",
  privateKeyId: "ALCHEMY_GCP_SERVICE_ACCOUNT_KEY_ID",
  privateKey: "ALCHEMY_GCP_SERVICE_ACCOUNT_KEY",
} as const;

/**
 * Whether a host runs its code as a GCP service account: Cloud Run, Cloud
 * Functions, or a Kubernetes workload on a GKE cluster (Workload Identity).
 * Deploy-time only: it reads the host's props.
 */
export const runsAsServiceAccount = (host: ResourceLike): boolean => {
  switch (host.Type) {
    case "GCP.Run.Service":
    case "GCP.Run.Job":
    case "GCP.Run.WorkerPool":
    case "GCP.CloudFunctions.Function":
      return true;
    case "Kubernetes.Deployment":
    case "Kubernetes.Job":
      return isGkeCluster(host.Props?.cluster);
    default:
      return false;
  }
};

/** A `GCP.Container.Cluster`, or a cluster connection authenticating as `gcp-gke`. */
const isGkeCluster = (cluster: unknown): boolean => {
  if (isResourceOfType(cluster, "GCP.Container.Cluster")) return true;
  const value = cluster as { auth?: { kind?: string }; connection?: { auth?: { kind?: string } } };
  return value?.auth?.kind === "gcp-gke" || value?.connection?.auth?.kind === "gcp-gke";
};

/** Label a grant `Allow(<host>, <label>)`, as `host.bind` records it. */
const allow = (label: TemplateStringsArray): TemplateStringsArray => {
  const strings = ["Allow(", `, ${label[0]}`, ...label.slice(1)];
  strings[strings.length - 1] += ")";
  return Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray;
};

type BindTarget = {
  bind: (...args: unknown[]) => (data: unknown) => Effect.Effect<void>;
};

/**
 * The `bind` for a binding's layer: yield it while the layer is built, then
 * call it from the returned function, behind a literal
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` so the bundler drops it. It attaches
 * the binding to its host labelled `Allow(<host>, <label>)`:
 *
 * - a host that runs as a service account takes the roles on that account;
 * - any other host gets a service account and key; the account takes the
 *   roles and the key is bound into the host's env.
 *
 * ```ts
 * Effect.gen(function* () {
 *   const bind = yield* GCPBindings.Bind;
 *   return Effect.fn(function* (topic: Topic) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`GCP.PubSub.WriteTopic(${topic})`({ iam: [ … ] });
 *     }
 *   });
 * })
 * ```
 */
/** The signature {@link Bind} yields. */
export type BindHost = (
  label: TemplateStringsArray,
  ...args: unknown[]
) => (data: HostBinding) => Effect.Effect<void>;

export const Bind: Effect.Effect<BindHost> = Effect.gen(function* () {
  // Bindings only bind at deploy, so a host bundle captures nothing here
  // and drops the identity resources.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => () => Effect.void;
  const GcpServiceAccount = yield* ServiceAccount;
  const GcpServiceAccountKey = yield* ServiceAccountKey;

  return (label: TemplateStringsArray, ...args: unknown[]) =>
    Effect.fn(function* (data: HostBinding) {
      const host = yield* Binding.Host;
      if (host === undefined) return;

      if (runsAsServiceAccount(host)) {
        return yield* (host as unknown as BindTarget).bind(allow(label), host, ...args)(data);
      }

      const account = yield* GcpServiceAccount(`${host.LogicalId}ServiceAccount`, {
        displayName: `Alchemy: GCP access for ${host.LogicalId}`.slice(0, 100),
      });
      const key = yield* GcpServiceAccountKey(`${host.LogicalId}ServiceAccountKey`, {
        serviceAccount: account.email,
      });
      if (data.iam !== undefined && data.iam.length > 0) {
        yield* (account as unknown as BindTarget).bind(
          allow(label),
          host,
          ...args,
        )({
          iam: data.iam,
        });
      }
      const runtime = (yield* CurrentRuntimeContext)!;
      yield* runtime.set(KEY_ENV.email, account.email);
      yield* runtime.set(KEY_ENV.project, account.project);
      yield* runtime.set(KEY_ENV.privateKeyId, key.privateKeyId);
      yield* runtime.set(KEY_ENV.privateKey, key.privateKey);
      for (const [name, value] of Object.entries(data.env ?? {})) {
        yield* runtime.set(name, Output.isOutput(value) ? value : Output.literal(value));
      }
    });
});

/**
 * Resolve a distilled operation with the host's GCP credentials, once when
 * the binding's layer is built: with the key {@link Bind} created for this
 * host if there is one, as-is otherwise (the host's own service account, or
 * the deployer).
 */
export const withCredentials: <Op>(operation: Effect.Effect<Op, never, any>) => Effect.Effect<Op> =
  Effect.fn(function* <Op>(operation: Effect.Effect<Op, never, any>) {
    // A host running as a service account signs with its own credentials.
    if (globalThis.__ALCHEMY_HOST_IDENTITY__ === "GCP.IAM.ServiceAccount")
      return yield* operation as Effect.Effect<Op>;
    const runtime = yield* CurrentRuntimeContext;
    const email =
      globalThis.__ALCHEMY_RUNTIME__ && runtime !== undefined
        ? yield* runtime.get<string>(KEY_ENV.email)
        : undefined;
    if (runtime === undefined || email === undefined) {
      return yield* operation as Effect.Effect<Op>;
    }
    const privateKey = yield* runtime.get<string | Redacted.Redacted<string>>(KEY_ENV.privateKey);
    const key = fromServiceAccountKey({
      clientEmail: email,
      project: (yield* runtime.get<string>(KEY_ENV.project))!,
      privateKeyId: (yield* runtime.get<string>(KEY_ENV.privateKeyId))!,
      privateKey: Redacted.isRedacted(privateKey) ? privateKey : Redacted.make(privateKey ?? ""),
    });
    const credentials = Context.get(yield* Layer.build(key).pipe(Effect.scoped), Credentials);
    return yield* (operation as Effect.Effect<Op>).pipe(
      Effect.provide(
        Layer.mergeAll(Layer.succeed(Credentials, credentials), FetchHttpClient.layer),
      ),
    );
  });

/**
 * Fail at deploy for a binding that needs its host to run as a service
 * account, e.g. one that reads ID tokens from the metadata server.
 */
export const requireServiceAccountHost = Effect.fn(function* (tag: string) {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const host = yield* Binding.Host;
  if (host === undefined || runsAsServiceAccount(host)) return;
  return yield* Effect.die(
    new Error(
      `${tag} needs a host that runs as a GCP service account (Cloud Run, Cloud Functions or GKE), not ${host.Type} ${host.LogicalId}.`,
    ),
  );
});
