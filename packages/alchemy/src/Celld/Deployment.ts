import { createHash } from "node:crypto";
import * as Node from "@distilled.cloud/celld/node";
import * as Effect from "effect/Effect";
import type { Store } from "./FleetStorage.ts";
import {
  decode,
  digest,
  encode,
  ensureImmutable,
  equalBytes,
  refuse,
  validate,
  DeploymentError,
} from "./Deployment/Objects.ts";
import { validCron } from "./Deployment/Cron.ts";
import {
  containerArtifactsKey,
  prepareContainers,
  verifyStoredContainerArtifacts,
  type ContainerArtifactDescriptor,
} from "./Deployment/Containers.ts";

export { stageContainerArtifacts } from "./Deployment/Containers.ts";
export type { ContainerArtifactDescriptor } from "./Deployment/Containers.ts";

export { DeploymentError } from "./Deployment/Objects.ts";
export {
  publishApplication,
  readPublicationReceipt,
  readPublicationRecovery,
  readPublicationTransaction,
  verifyPublicationReceipt,
  APPLICATION_CLAIM_KEY,
  APPLICATION_LOCK_KEY,
  APPLICATION_RECEIPT_KEY,
} from "./Deployment/Publication.ts";
export type {
  ApplicationOwner,
  PublishApplicationOptions,
  PublicationReceipt,
  PublicationResult,
} from "./Deployment/Publication.ts";

export interface DeploymentModule {
  /** Safe deployment-relative module path. */
  readonly name: string;
  /** Exact bundled module contents; strings are encoded as UTF-8. */
  readonly content: string | Uint8Array;
  /** Native compiled-Wasm module kind; all other siblings are text modules. */
  readonly kind?: "wasm";
}

export interface DeploymentAssets {
  /** Native v1 index. Entries use absolute URL paths, not filesystem paths. */
  readonly index: Node.AssetIndex;
  /** Exact bodies for every digest in the index. Extra or missing blobs are refused. */
  readonly blobs: readonly {
    readonly sha256: string;
    readonly body: Uint8Array;
  }[];
}

export interface PrepareDeploymentInput {
  /** Native Worker name: lowercase ASCII letters, digits and internal hyphens. */
  readonly scriptName: string;
  /** Entry module path, matching metadata.main_module when present. */
  readonly mainModule: string;
  /** Bundled modules, with no CLI or bundler invocation during preparation. */
  readonly modules: readonly DeploymentModule[];
  /** Native upload metadata; serialized with serde_json's sorted object keys. */
  readonly metadata: Record<string, unknown>;
  /** User-exported Durable Object classes, excluding runtime-reserved names. */
  readonly doClasses: readonly string[];
  /** SQLite-backed subset of user classes. */
  readonly sqliteClasses: readonly string[];
  /** Root schedules; intentionally excluded from the native version hash. */
  readonly crons?: readonly string[];
  /** Normalized native queue consumer policies; included in raw metadata identity. */
  readonly queueConsumers?: readonly Node.QueueConsumerConfig[];
  /** Content-addressed native assets. */
  readonly assets?: DeploymentAssets;
  /** Native container specs, validated against user SQLite classes. */
  readonly containers?: readonly Node.ContainerSpec[];
  /** Native immutable fence image tag, required when containers are present. */
  readonly fenceImage?: string;
  /** Exact archive descriptors from the image builder; archives must already be stored before staging. */
  readonly containerArtifacts?: readonly ContainerArtifactDescriptor[];
  /** Install operator classes before any Application exists. Used by Bootstrap. */
  readonly systemClasses?: readonly ("d1" | "kv" | "queues")[];
}

export interface UploadObject {
  /** Exact object-store key. */
  readonly key: string;
  /** Exact persisted bytes. */
  readonly body: Uint8Array;
}

export interface PreparedDeployment {
  /** First 16 hexadecimal digits of Celld's native deployment hash. */
  readonly version: string;
  /** Native immutable deployment prefix. */
  readonly prefix: string;
  /** Native script identity. */
  readonly scriptName: string;
  /** Validated generated-SDK manifest. Only its cron fields may change at publication. */
  readonly manifest: Node.Manifest;
  /** Validated generated-SDK pointer; staging never writes it. */
  readonly pointer: Node.DeployPointer;
  /** Prefix-local modules and optional asset index, excluding the manifest. */
  readonly objects: readonly UploadObject[];
  /** Fleet-wide content-addressed blobs. Staging verifies these; it never publishes them. */
  readonly assetObjects: readonly UploadObject[];
  /** Verified identities of every native container and fence archive. */
  readonly containerArtifacts?: readonly ContainerArtifactDescriptor[];
  /** Alchemy-only archive verification metadata; never added to the native manifest. */
  readonly artifactDescriptor?: UploadObject;
  /** Full manifest staged for the exclusive Application publisher. */
  readonly candidate: UploadObject;
}

const reservedClass = (name: string) =>
  ["__D1Database", "__Workflow", "__KvNamespace", "__Queue"].includes(name) ||
  name.startsWith("__Workflow.");
export const validScriptName = (name: string) =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) &&
  !["queues", "images"].includes(name);
export const validDeploymentPath = (name: string) =>
  name.length > 0 &&
  [...name].every(
    (character) =>
      character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
  ) &&
  !/[\\:%?#]/.test(name) &&
  name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const validScope = (name: string) =>
  /^[A-Za-z0-9_.:$-]{1,255}$/.test(name) && name !== "." && name !== "..";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateConsumer = (consumer: Node.QueueConsumerConfig) => {
  const bounded = (value: number | undefined, min: number, max: number) =>
    value === undefined ||
    (Number.isInteger(value) && value >= min && value <= max);
  return (
    validScope(consumer.queue) &&
    bounded(consumer.max_batch_size, 1, 100) &&
    bounded(consumer.max_batch_timeout, 0, 60) &&
    bounded(consumer.max_retries, 0, 100) &&
    bounded(consumer.max_concurrency, 1, 250) &&
    bounded(consumer.retry_delay, 0, 86400) &&
    (consumer.dead_letter_queue === undefined ||
      (validScope(consumer.dead_letter_queue) &&
        consumer.dead_letter_queue !== consumer.queue))
  );
};

const prepareAssets = (input: DeploymentAssets) =>
  Effect.gen(function* () {
    const index = yield* validate(Node.AssetIndex, input.index);
    if (
      index.schema_version !== 1 ||
      Object.keys(index.entries).length > 20_000
    )
      return yield* refuse(
        "configuration",
        "Unsupported or oversized asset index.",
      );
    const config = index.config;
    if (
      config.html_handling !== undefined &&
      ![
        "auto-trailing-slash",
        "force-trailing-slash",
        "drop-trailing-slash",
        "none",
      ].includes(config.html_handling)
    )
      return yield* refuse("configuration", "Unsupported asset html_handling.");
    if (
      config.not_found_handling !== undefined &&
      !["none", "404-page", "single-page-application"].includes(
        config.not_found_handling,
      )
    )
      return yield* refuse(
        "configuration",
        "Unsupported asset not_found_handling.",
      );
    const blobs = new Map(input.blobs.map((blob) => [blob.sha256, blob.body]));
    if (blobs.size !== input.blobs.length)
      return yield* refuse("configuration", "Duplicate asset blobs.");
    const used = new Set<string>();
    let total = 0;
    const entries: Record<string, Node.AssetEntry> = {};
    const entryNames = yield* Effect.sync(() =>
      Object.keys(index.entries).sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      ),
    );
    for (const name of entryNames) {
      const entry = index.entries[name]!;
      const body = blobs.get(entry.sha256);
      if (
        !name.startsWith("/") ||
        !validDeploymentPath(name.slice(1)) ||
        !body ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        entry.bytes !== body.length ||
        entry.bytes > 25 * 1024 * 1024 ||
        (yield* digest(body)) !== entry.sha256
      )
        return yield* refuse("configuration", `Invalid asset entry: ${name}`);
      used.add(entry.sha256);
      total += entry.bytes;
      entries[name] = {
        sha256: entry.sha256,
        bytes: entry.bytes,
        ...(entry.content_type === undefined
          ? {}
          : { content_type: entry.content_type }),
      };
    }
    if (used.size !== blobs.size || total > 1024 * 1024 * 1024)
      return yield* refuse(
        "configuration",
        "Extra asset blobs or oversized asset deployment.",
      );
    // AssetIndex is a Rust struct, not a serde_json::Value: field order is significant.
    const body = yield* Effect.try({
      try: () =>
        new TextEncoder().encode(
          JSON.stringify({
            schema_version: 1,
            entries,
            config: {
              ...(config.binding === undefined
                ? {}
                : { binding: config.binding }),
              ...(config.html_handling === undefined
                ? {}
                : { html_handling: config.html_handling }),
              ...(config.not_found_handling === undefined
                ? {}
                : { not_found_handling: config.not_found_handling }),
              run_worker_first: config.run_worker_first ?? false,
              ...(config.headers === undefined
                ? {}
                : { headers: config.headers }),
              ...(config.redirects === undefined
                ? {}
                : { redirects: config.redirects }),
              ...(config.compatibility_date === undefined
                ? {}
                : { compatibility_date: config.compatibility_date }),
              ...(config.compatibility_flags?.length
                ? { compatibility_flags: config.compatibility_flags }
                : {}),
            },
          }),
        ),
      catch: (cause) =>
        new DeploymentError({
          reason: "configuration",
          message: "Cannot serialize native asset index.",
          cause,
        }),
    });
    return {
      body,
      reference: {
        index: "assets.json",
        sha256: yield* digest(body),
        file_count: Object.keys(entries).length,
        total_bytes: total,
      },
      objects: input.blobs.map((blob) => ({
        key: `deploy-blobs/assets/sha256/${blob.sha256.slice(0, 2)}/${blob.sha256}`,
        body: blob.body,
      })),
    };
  });

/** Prepare native v0.5 artifacts without a deployment CLI or live pointer mutation. */
export const prepareDeployment = (input: PrepareDeploymentInput) =>
  Effect.gen(function* () {
    if (!validScriptName(input.scriptName))
      return yield* refuse(
        "configuration",
        "Unsafe or reserved Celld script name.",
      );
    const { containers, artifacts: containerArtifacts } =
      yield* prepareContainers({
        containers: input.containers ?? [],
        fenceImage: input.fenceImage,
        artifacts: input.containerArtifacts ?? [],
        doClasses: input.doClasses,
        sqliteClasses: input.sqliteClasses,
      });
    if (
      input.metadata.containers !== undefined &&
      !(yield* equalBytes(
        yield* encode(input.metadata.containers),
        yield* encode(containers),
      ))
    )
      return yield* refuse(
        "configuration",
        "Container metadata disagrees with the native manifest.",
      );
    if (
      input.doClasses.some(reservedClass) ||
      input.sqliteClasses.some(reservedClass)
    )
      return yield* refuse(
        "configuration",
        "Runtime class names cannot be declared as user classes.",
      );
    if (
      new Set(input.doClasses).size !== input.doClasses.length ||
      new Set(input.sqliteClasses).size !== input.sqliteClasses.length ||
      input.sqliteClasses.some((name) => !input.doClasses.includes(name)) ||
      input.doClasses.some((name) => !validScope(name))
    )
      return yield* refuse(
        "configuration",
        "Invalid or duplicate Durable Object classes.",
      );
    if (
      input.metadata.main_module !== undefined &&
      input.metadata.main_module !== input.mainModule
    )
      return yield* refuse(
        "configuration",
        "Metadata entry module disagrees with mainModule.",
      );
    if (
      input.modules.some(
        (module) =>
          !validDeploymentPath(module.name) ||
          ["manifest.json", "assets.json", "current.json"].includes(
            module.name.split("/")[0]!,
          ),
      ) ||
      new Set(input.modules.map((module) => module.name)).size !==
        input.modules.length
    )
      return yield* refuse(
        "configuration",
        "Invalid, reserved, or duplicate module path.",
      );
    const main = input.modules.find(
      (module) => module.name === input.mainModule,
    );
    if (!main || main.kind === "wasm" || main.name.endsWith(".wasm"))
      return yield* refuse(
        "configuration",
        "Missing or non-JavaScript main module.",
      );
    const modules = yield* Effect.forEach(input.modules, (module) =>
      Effect.try({
        try: () => {
          const body =
            typeof module.content === "string"
              ? new TextEncoder().encode(module.content)
              : new Uint8Array(module.content);
          const kind =
            module.kind ?? (module.name.endsWith(".wasm") ? "wasm" : undefined);
          if (!kind) new TextDecoder("utf-8", { fatal: true }).decode(body);
          return { name: module.name, body, ...(kind ? { kind } : {}) };
        },
        catch: (cause) =>
          new DeploymentError({
            reason: "configuration",
            message: `Invalid module: ${module.name}`,
            cause,
          }),
      }),
    );
    const metadata = input.metadata;
    const bindingsValue = metadata.bindings ?? [];
    if (!Array.isArray(bindingsValue) || !bindingsValue.every(record))
      return yield* refuse(
        "configuration",
        "metadata.bindings must be native binding records.",
      );
    const bindings = bindingsValue.filter(record);
    const names = new Set<string>();
    const fields: Record<string, readonly string[]> = {
      durable_object_namespace: ["class_name"],
      service: ["service"],
      d1: ["database_name"],
      kv: ["id"],
      queue: ["queue"],
      workflow: ["workflow_name", "class_name"],
      r2_bucket: ["bucket_name"],
      worker_loader: [],
      plain_text: ["text"],
      assets: [],
    };
    for (const binding of bindings) {
      if (
        typeof binding.type !== "string" ||
        !Object.hasOwn(fields, binding.type) ||
        typeof binding.name !== "string" ||
        !/^[$A-Z_a-z][$A-Z_a-z0-9]*$/.test(binding.name) ||
        names.has(binding.name)
      )
        return yield* refuse(
          "configuration",
          "Unknown native binding type, invalid name, or duplicate environment binding.",
        );
      names.add(binding.name);
      if (
        fields[binding.type]!.some(
          (key) =>
            typeof binding[key] !== "string" ||
            (key !== "text" && binding[key] === ""),
        )
      )
        return yield* refuse(
          "configuration",
          `Incomplete native ${binding.type} binding.`,
        );
      if (
        binding.type === "durable_object_namespace" &&
        (typeof binding.class_name !== "string" ||
          !input.doClasses.includes(binding.class_name))
      )
        return yield* refuse(
          "configuration",
          "A Durable Object binding references an undeclared user class.",
        );
      if (
        binding.type === "queue" &&
        (typeof binding.queue !== "string" ||
          !validScope(binding.queue) ||
          (binding.delivery_delay !== undefined &&
            (typeof binding.delivery_delay !== "number" ||
              !Number.isInteger(binding.delivery_delay) ||
              binding.delivery_delay < 0 ||
              binding.delivery_delay > 86400)))
      )
        return yield* refuse(
          "configuration",
          "Invalid queue producer binding.",
        );
      if (binding.type === "assets" && !input.assets)
        return yield* refuse(
          "configuration",
          "Asset binding has no native asset index.",
        );
    }
    const has = (type: string) =>
      bindings.some((binding) => binding.type === type);
    const consumers = yield* validate(
      Node.QueueConsumerConfigs,
      input.queueConsumers ?? metadata.queue_consumers ?? [],
    );
    if (
      new Set(consumers.map((consumer) => consumer.queue)).size !==
        consumers.length ||
      consumers.some((consumer) => !validateConsumer(consumer))
    )
      return yield* refuse(
        "configuration",
        "Invalid queue consumer configuration.",
      );
    const rawMetadata = {
      ...metadata,
      ...(consumers.length ? { queue_consumers: consumers } : {}),
      ...(containers.length ? { containers } : {}),
    };
    if (
      input.queueConsumers &&
      metadata.queue_consumers !== undefined &&
      !(yield* equalBytes(
        yield* encode(metadata.queue_consumers),
        yield* encode(consumers),
      ))
    )
      return yield* refuse(
        "configuration",
        "Queue consumer metadata disagrees with the manifest.",
      );
    const systems = input.systemClasses ?? [];
    const usesD1 = has("d1") || systems.includes("d1");
    const usesKV = has("kv") || systems.includes("kv");
    const usesQueues =
      has("queue") || consumers.length > 0 || systems.includes("queues");
    const builtin = [
      ...(usesD1 ? ["__D1Database"] : []),
      ...(usesKV ? ["__KvNamespace"] : []),
      ...(usesQueues ? ["__Queue"] : []),
      ...(has("workflow") ? [`__Workflow.${input.scriptName}`] : []),
    ];
    const crons = (input.crons ?? []).map((cron) => cron.trim());
    if (
      new Set(crons).size !== crons.length ||
      crons.some((cron) => !validCron(cron))
    )
      return yield* refuse(
        "configuration",
        "Invalid native five-field cron expression.",
      );
    const assets = input.assets
      ? yield* prepareAssets(input.assets)
      : undefined;
    const metadataBytes = yield* encode(rawMetadata);
    const version = yield* Effect.sync(() => {
      const hash = createHash("sha256");
      for (const module of [...modules].sort((a, b) =>
        Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
      ))
        hash
          .update(module.name)
          .update(new Uint8Array([0]))
          .update(module.body);
      hash.update(metadataBytes);
      if (assets)
        hash
          .update(new Uint8Array([0]))
          .update("assets.json")
          .update(new Uint8Array([0]))
          .update(assets.body);
      return hash.digest("hex").slice(0, 16);
    });
    const prefix = `deploy/${input.scriptName}/${version}`;
    const flags = metadata.compatibility_flags;
    const manifest = yield* validate(Node.Manifest, {
      schema_version: assets ? 2 : 1,
      version,
      script_name: input.scriptName,
      main_module: input.mainModule,
      do_classes: [...input.doClasses, ...builtin],
      sqlite_classes: [...input.sqliteClasses, ...builtin],
      modules: yield* Effect.forEach(modules, (module) =>
        Effect.gen(function* () {
          return {
            name: module.name,
            bytes: module.body.length,
            sha256: yield* digest(module.body),
            ...(module.kind ? { kind: module.kind } : {}),
          };
        }),
      ),
      ...(assets ? { assets: assets.reference } : {}),
      ...(crons.length ? { crons } : {}),
      ...(consumers.length ? { queue_consumers: consumers } : {}),
      ...(containers.length
        ? { containers, fence_image: input.fenceImage }
        : {}),
      required_features: [
        ...(assets ? ["assets-v1"] : []),
        ...(crons.length ? ["cron-v1"] : []),
        ...(containers.length ? ["containers-v1"] : []),
        ...(usesD1 ? ["d1-v1"] : []),
        ...(has("workflow") ? ["workflows-v1"] : []),
        ...(usesKV ? ["kv-v1"] : []),
        ...(usesQueues ? ["queues-v1"] : []),
        ...(has("r2_bucket") ? ["r2-v1"] : []),
        ...(Array.isArray(flags) && flags.includes("sqlite_vec")
          ? ["sqlite-vec-v1"]
          : []),
        ...(modules.some((module) => module.kind === "wasm")
          ? ["wasm-v1"]
          : []),
      ],
      raw_metadata: rawMetadata,
    });
    const pointer = yield* validate(Node.DeployPointer, {
      script_name: input.scriptName,
      version,
      prefix,
      rollout: { percent: 100 },
    });
    const manifestBytes = yield* encode(manifest);
    const candidateKey = `alchemy/deployments/v1/candidates/${input.scriptName}/${version}/${yield* digest(manifestBytes)}.json`;
    const prepared: PreparedDeployment = {
      version,
      prefix,
      scriptName: input.scriptName,
      manifest,
      pointer,
      objects: [
        ...modules.map((module) => ({
          key: `${prefix}/${module.name}`,
          body: module.body,
        })),
        ...(assets
          ? [{ key: `${prefix}/assets.json`, body: assets.body }]
          : []),
      ],
      assetObjects: assets?.objects ?? [],
      containerArtifacts,
      ...(containerArtifacts.length
        ? {
            artifactDescriptor: {
              key: containerArtifactsKey(candidateKey),
              body: yield* encode({
                schemaVersion: 1,
                artifacts: containerArtifacts,
              }),
            },
          }
        : {}),
      candidate: {
        key: candidateKey,
        body: manifestBytes,
      },
    };
    return prepared;
  });

export const sameImmutableManifest = (
  left: Node.Manifest,
  right: Node.Manifest,
) =>
  Effect.gen(function* () {
    const base = (manifest: Node.Manifest) => {
      const { crons: _crons, required_features: features, ...rest } = manifest;
      return {
        ...rest,
        required_features: (features ?? []).filter(
          (feature) => feature !== "cron-v1",
        ),
      };
    };
    return yield* equalBytes(
      yield* encode(base(left)),
      yield* encode(base(right)),
    );
  });

/** Publish only immutable asset blobs, before staging the referencing prefix. */
export const stageAssetBlobs = (store: Store, prepared: PreparedDeployment) =>
  Effect.gen(function* () {
    for (const object of prepared.assetObjects)
      yield* ensureImmutable(store, object.key, object.body);
  });

/** Stage a complete prefix and candidate manifest, never pointers or queue attachments. */
export const stageDeployment = (store: Store, prepared: PreparedDeployment) =>
  Effect.gen(function* () {
    const { artifacts } = yield* prepareContainers({
      containers: prepared.manifest.containers ?? [],
      fenceImage: prepared.manifest.fence_image,
      artifacts: prepared.containerArtifacts ?? [],
      doClasses: prepared.manifest.do_classes,
      sqliteClasses: prepared.manifest.sqlite_classes,
    });
    if (artifacts.length) {
      const descriptor = prepared.artifactDescriptor;
      if (
        !prepared.manifest.required_features?.includes("containers-v1") ||
        !descriptor ||
        descriptor.key !== containerArtifactsKey(prepared.candidate.key) ||
        !(yield* equalBytes(
          descriptor.body,
          yield* encode({ schemaVersion: 1, artifacts }),
        ))
      )
        return yield* refuse(
          "configuration",
          "Container staging requires matching native features and exact archive verification metadata.",
        );
    } else if (prepared.artifactDescriptor)
      return yield* refuse(
        "configuration",
        "Unexpected container archive verification metadata.",
      );
    yield* verifyStoredContainerArtifacts(store, artifacts);
    for (const object of prepared.assetObjects) {
      const observed = yield* store.get(object.key);
      if (!observed || !(yield* equalBytes(observed.body, object.body)))
        return yield* refuse(
          "configuration",
          `Stage asset blobs before their deployment: ${object.key}`,
        );
    }
    const manifestKey = `${prepared.prefix}/manifest.json`;
    const observed = yield* store.get(manifestKey);
    if (
      observed &&
      !(yield* sameImmutableManifest(
        yield* decode(Node.Manifest, observed.body),
        prepared.manifest,
      ))
    )
      return yield* refuse(
        "collision",
        `Version collision at ${manifestKey}; only cron fields may differ.`,
      );
    for (const object of prepared.objects)
      yield* ensureImmutable(store, object.key, object.body);
    if (prepared.artifactDescriptor)
      yield* ensureImmutable(
        store,
        prepared.artifactDescriptor.key,
        prepared.artifactDescriptor.body,
      );
    yield* ensureImmutable(
      store,
      prepared.candidate.key,
      prepared.candidate.body,
    );
    if (!observed) {
      yield* ensureImmutable(store, manifestKey, prepared.candidate.body).pipe(
        Effect.catchTag("Celld.FleetStorageError", (error) =>
          Effect.gen(function* () {
            if (error.reason !== "conflict") return yield* Effect.fail(error);
            const concurrent = yield* store.get(manifestKey);
            if (
              !concurrent ||
              !(yield* sameImmutableManifest(
                yield* decode(Node.Manifest, concurrent.body),
                prepared.manifest,
              ))
            )
              return yield* Effect.fail(error);
          }),
        ),
      );
    }
    return { prefix: prepared.prefix, candidateKey: prepared.candidate.key };
  });
