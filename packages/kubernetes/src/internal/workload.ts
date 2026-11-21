import {
  makeContainerBootstrap,
  type ContainerRuntimeSettings,
} from "@alchemy.run/docker/ContainerRuntime";
import { isInlineDockerfile } from "@alchemy.run/docker/Dockerfile";
import { hashDirectory } from "alchemy/Command/Memo";
import type { ResourceBinding } from "alchemy/Resource";
import { unwrapRedacted } from "alchemy/Util/data";
import { collectRedactedSecrets } from "alchemy/Util/Redaction";
import { sha256Object } from "alchemy/Util/sha256";
/**
 * Internal helpers shared by the Kubernetes workload platforms
 * (`Kubernetes.Deployment`, `Kubernetes.Job`): image-source dispatch
 * through the cluster adapter, binding-env collection, connection
 * identity, and container bootstrap selection.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type {
  ClusterAdapterService,
  IdentityState,
  WorkloadBindingContract,
  WorkloadImageSource,
} from "../ClusterAdapter.ts";
import type { ClusterLike, Connection, ConnectionAuth } from "../Connection.ts";
import type { ConnectionRegistry } from "./registry.ts";

/**
 * Structural deep merge: objects merge recursively; arrays and primitives
 * from `override` replace the base value wholesale. Powers escape hatches
 * like `Kubernetes.Deployment.podTemplate`.
 */
export const deepMerge = <T>(base: T, override: unknown): T => {
  if (override === undefined) return base;
  if (
    base === null ||
    override === null ||
    typeof base !== "object" ||
    typeof override !== "object" ||
    Array.isArray(base) ||
    Array.isArray(override)
  ) {
    return override as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      key in (base as Record<string, unknown>)
        ? deepMerge((base as Record<string, unknown>)[key], value)
        : value;
  }
  return out as T;
};

/**
 * The image build platform of a workload: its own `architecture`, else the
 * connection's node architecture, else `linux/amd64`.
 */
export const imagePlatformOf = (
  architecture: "amd64" | "arm64" | undefined,
  connection?: Connection,
): string =>
  (architecture ?? connection?.architecture) === "arm64" ? "linux/arm64" : "linux/amd64";

/**
 * Best-effort {@link Connection} of a `cluster` prop value — `undefined`
 * instead of throwing, for plan-time diffs where the referenced resource
 * may resolve to stables-only (or `{}`).
 */
export const tryConnectionOf = (cluster: ClusterLike | undefined): Connection | undefined => {
  if (cluster === undefined) return undefined;
  if ("auth" in cluster && cluster.auth !== undefined) return cluster;
  if ("connection" in cluster && cluster.connection !== undefined) {
    return cluster.connection;
  }
  return undefined;
};

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortKeysDeep(entry)]),
  );
};

/**
 * A stable identity string for a connection's *target cluster* — the auth
 * descriptor (which names the cluster for managed clouds and the
 * kubeconfig context otherwise). Changing it means the workload moves
 * clusters, which is a replacement. Deliberately excludes `endpoint` /
 * CA: managed clusters can rotate those in place.
 */
export const connectionIdentity = (connection: Connection | undefined): string | undefined =>
  connection === undefined ? undefined : JSON.stringify(sortKeysDeep(connection.auth));

/**
 * The persisted connection of a workload's attributes, tolerating legacy
 * pre-rename rows (`AWS.EKS.*` attributes carried a flat `clusterName`
 * instead of a `connection`) by synthesizing an `aws-eks` connection —
 * the only platform those legacy types could target.
 */
export const connectionOfOutput = (output: Record<string, unknown>): Connection | undefined => {
  const connection = output.connection as Connection | undefined;
  if (connection?.auth !== undefined) return connection;
  if (typeof output.clusterName === "string") {
    return {
      auth: { kind: "aws-eks", clusterName: output.clusterName } as unknown as ConnectionAuth,
    };
  }
  return undefined;
};

/**
 * Collect environment variables from a host's active bindings and report
 * which cloud-grant channels (any binding-data key besides `env`, e.g.
 * AWS `policyStatements`) are in play — the caller fails when grants
 * exist but the cluster has no identity adapter to materialize them.
 */
export const collectBindingEnv = (
  bindings: ResourceBinding<WorkloadBindingContract>[],
): { env: Record<string, any>; grantKeys: string[] } => {
  const activeBindings = bindings.filter(
    (binding: ResourceBinding<WorkloadBindingContract> & { action?: string }) =>
      binding.action !== "delete",
  );

  const env = activeBindings
    .map((binding) => binding?.data?.env)
    .reduce<Record<string, any>>((acc, value) => ({ ...acc, ...value }), {});

  const grantKeys = [
    ...new Set(
      activeBindings.flatMap((binding) =>
        Object.keys(binding?.data ?? {}).filter(
          (key) => key !== "env" && (binding.data as Record<string, unknown>)[key] !== undefined,
        ),
      ),
    ),
  ];

  return { env, grantKeys };
};

/**
 * Kubernetes env values are strings. A {@link Redacted} string stays wrapped
 * so the request serializer unwraps it. Any other value that holds a secret
 * is JSON, still wrapped, so a failed apply can scrub the inner strings.
 */
export const containerEnvValue = (value: unknown): string | Redacted.Redacted<string> => {
  if (typeof value === "string") return value;
  if (Redacted.isRedacted(value)) {
    const inner = Redacted.value(value);
    if (typeof inner === "string") return Redacted.make(inner);
  }
  const json = JSON.stringify(unwrapRedacted(value));
  return collectRedactedSecrets(value).length > 0 ? Redacted.make(json) : json;
};

export type ImageSourceKind = "main" | "context" | "image";

/** Which image source a props bag declares (`main` always wins). */
export const imageSourceKind = (source: WorkloadImageSource): ImageSourceKind | undefined =>
  source.main !== undefined
    ? "main"
    : source.image !== undefined
      ? "image"
      : source.context !== undefined || source.dockerfile !== undefined
        ? "context"
        : undefined;

/**
 * Content hash for image sources whose identity is computable without a
 * bundler: `image` (the ref + platform) and `context` (the build-context
 * directory + Dockerfile content + platform). `main` returns `undefined`
 * — its hash comes from the bundle output inside the registry adapter.
 */
export const computeStaticWorkloadImageHash = Effect.fn(function* (
  source: WorkloadImageSource,
  platform: string,
) {
  const kind = imageSourceKind(source);
  if (kind === "image") {
    return (yield* sha256Object({ image: source.image!, platform })).slice(0, 16);
  }
  if (kind === "context") {
    if (source.dockerfile !== undefined && isInlineDockerfile(source.dockerfile)) {
      if (typeof source.dockerfile.content !== "string") return undefined;
      return (yield* sha256Object({ dockerfile: source.dockerfile.content, platform })).slice(
        0,
        16,
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const context = path.resolve(source.context ?? ".");
    const dockerfile =
      typeof source.dockerfile === "string"
        ? path.resolve(source.dockerfile)
        : path.join(context, "Dockerfile");
    if (!(yield* fs.exists(context)) || !(yield* fs.exists(dockerfile))) {
      return undefined;
    }
    const contextHash = yield* hashDirectory({ cwd: context });
    const dockerfileContent = yield* fs.readFileString(dockerfile);
    return (yield* sha256Object({ contextHash, dockerfile: dockerfileContent, platform })).slice(
      0,
      16,
    );
  }
  return undefined;
});

/**
 * Use the selected runtime's compatibility templates when provided. Cloud
 * adapters can override those and supply a module for the shared path to
 * wire workload identity.
 */
const workloadBootstrap = Effect.fnUntraced(function* (options: {
  adapter: ClusterAdapterService;
  source: WorkloadImageSource;
  mode: "server" | "job";
  isExternal?: boolean;
  runtime: ContainerRuntimeSettings;
}) {
  const { adapter, mode, runtime, source } = options;
  const handler = source.handler ?? "default";
  const hostBootstrap = adapter.bootstrap?.[mode];
  const compatibilityBootstrap = runtime.compatibilityBootstrap?.[mode];
  if (compatibilityBootstrap !== undefined) {
    return (hostBootstrap ?? compatibilityBootstrap)(handler);
  }
  // Static images and external programs do not use the generated entrypoint.
  if (source.main === undefined || options.isExternal) {
    return hostBootstrap?.(handler) ?? (() => "");
  }
  if (hostBootstrap !== undefined && adapter.runtimeBootstrap === undefined) {
    return yield* Effect.die(
      new Error(
        "This Kubernetes cluster adapter needs a runtimeBootstrap module to use a custom ContainerRuntime.",
      ),
    );
  }
  return makeContainerBootstrap(
    runtime.platformModule,
    adapter.runtimeBootstrap ?? "alchemy/Runtime/ContainerProcess",
    handler,
    mode,
  );
});

export interface ResolveWorkloadImageOptions {
  adapter: ClusterAdapterService;
  /** The target connection — its `registry`, if any, receives builds. */
  connection: Connection;
  /** Publisher for connection-level registries. */
  connectionRegistry: ConnectionRegistry;
  id: string;
  source: WorkloadImageSource;
  platform: string;
  port?: number | undefined;
  isExternal?: boolean | undefined;
  mode: "server" | "job";
  runtime: ContainerRuntimeSettings;
  tags: Record<string, string>;
  /** Persisted registry state hints (legacy-shape tolerant). */
  state: Record<string, unknown> | undefined;
  session: { note: (message: string) => Effect.Effect<void> };
}

/**
 * Resolve the container image for a workload: through the cluster
 * adapter's managed registry when it has one (build/mirror + push). Other
 * clusters run a pre-built `image` reference verbatim and build `main` /
 * `context` sources into the connection's `registry`, which those sources
 * require.
 */
export const resolveWorkloadImage = Effect.fn(function* (options: ResolveWorkloadImageOptions) {
  const { adapter, source } = options;
  const bootstrap = yield* workloadBootstrap(options);
  if (adapter.registry !== undefined) {
    return yield* adapter.registry.resolve({
      id: options.id,
      source,
      platform: options.platform,
      port: options.port,
      isExternal: options.isExternal,
      bootstrap,
      runtime: options.runtime,
      tags: options.tags,
      state: options.state,
      session: options.session,
    });
  }

  const kind = imageSourceKind(source);
  if (kind === "image") {
    const codeHash = (yield* computeStaticWorkloadImageHash(source, options.platform))!;
    return { imageUri: source.image!, codeHash, state: undefined };
  }

  const registry = options.connection.registry;
  if (registry !== undefined) {
    return yield* options.connectionRegistry.resolve({
      id: options.id,
      registry,
      source,
      platform: options.platform,
      port: options.port,
      isExternal: options.isExternal,
      bootstrap,
      runtime: options.runtime,
      state: options.state,
      session: options.session,
    });
  }

  return yield* Effect.die(
    new Error(
      `'${options.id}': 'main' and 'context' image sources are built and ` +
        "pushed to a container registry, and this cluster connection has " +
        "none. Add a `registry` to the connection (e.g. " +
        '`Kubernetes.KubeConfig({ context, registry: { server: "ghcr.io/acme" } })`), ' +
        "use `Kubernetes.LocalCluster`, which includes one, or run a " +
        "pre-built `image` reference the cluster can pull.",
    ),
  );
});

/** Plan-time content hash for `diff` — adapter-aware. */
export const workloadImageHash = Effect.fn(function* (options: {
  adapter: ClusterAdapterService;
  connection: Connection;
  connectionRegistry: ConnectionRegistry;
  source: WorkloadImageSource;
  platform: string;
  port?: number | undefined;
  isExternal?: boolean | undefined;
  mode: "server" | "job";
  runtime: ContainerRuntimeSettings;
}) {
  const bootstrap = yield* workloadBootstrap(options);
  if (options.adapter.registry !== undefined) {
    return yield* options.adapter.registry.hash({
      source: options.source,
      platform: options.platform,
      port: options.port,
      isExternal: options.isExternal,
      bootstrap,
      runtime: options.runtime,
    });
  }
  if (options.connection.registry !== undefined && imageSourceKind(options.source) === "main") {
    return yield* options.connectionRegistry.hash({
      source: options.source,
      platform: options.platform,
      port: options.port,
      isExternal: options.isExternal,
      bootstrap,
      runtime: options.runtime,
    });
  }
  return yield* computeStaticWorkloadImageHash(options.source, options.platform);
});

/** The identity-adapter state persisted on workload attributes. */
// oxlint-disable-next-line typescript/no-redundant-type-constituents -- registry type is `never` until cloud packages augment it
export type PersistedIdentityState = IdentityState | undefined;

/** A container env entry read from elsewhere: a Secret key, a ConfigMap key, a field. */
export interface EnvValueFrom {
  readonly valueFrom: Record<string, unknown>;
}

const isEnvValueFrom = (value: unknown): value is EnvValueFrom =>
  typeof value === "object" &&
  value !== null &&
  !Redacted.isRedacted(value) &&
  Object.keys(value).length === 1 &&
  typeof (value as { valueFrom?: unknown }).valueFrom === "object" &&
  (value as { valueFrom?: unknown }).valueFrom !== null;

/** The annotation that rolls a workload's pods when its secret env changes. */
export const ENV_SECRET_DIGEST = "alchemy.run/env-secret-digest";

/**
 * A container's env as Kubernetes renders it: a plain value stays a literal,
 * `{ valueFrom }` passes through as an `EnvVarSource`, and a secret (a
 * `Redacted`, or a value holding one) moves into the workload's own Secret
 * `<name>-env`, read through `secretKeyRef`. Anyone who can read the pod
 * template sees the Secret's name, never its values. `digest` changes
 * whenever a secret value does, so pods roll as they did when the value was
 * a literal.
 */
export const workloadEnv = Effect.fn(function* (options: {
  readonly name: string;
  readonly namespace: string;
  readonly labels: Record<string, string>;
  readonly env: Record<string, unknown>;
}) {
  const secretName = `${options.name.slice(0, 249).replace(/-+$/, "")}-env`;
  const secrets: Record<string, Redacted.Redacted<string>> = {};
  const entries: Array<Record<string, unknown>> = [];
  for (const [name, raw] of Object.entries(options.env)) {
    if (isEnvValueFrom(raw)) {
      entries.push({ name, valueFrom: raw.valueFrom });
      continue;
    }
    const value = containerEnvValue(raw);
    if (Redacted.isRedacted(value)) {
      secrets[name] = value;
      entries.push({ name, valueFrom: { secretKeyRef: { name: secretName, key: name } } });
    } else {
      entries.push({ name, value });
    }
  }
  const names = Object.keys(secrets).sort();
  if (names.length === 0) return { entries, secret: undefined, digest: undefined };
  const data = yield* Effect.sync(() =>
    Object.fromEntries(
      names.map((name) => [
        name,
        Redacted.make(Buffer.from(Redacted.value(secrets[name]!), "utf8").toString("base64")),
      ]),
    ),
  );
  const digest = (yield* sha256Object(
    Object.fromEntries(names.map((name) => [name, Redacted.value(secrets[name]!)])),
  )).slice(0, 16);
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: secretName, namespace: options.namespace, labels: options.labels },
    type: "Opaque",
    data,
  };
  return { entries, secret, digest };
});
