import * as Node from "@distilled.cloud/celld/node";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  prepareDeployment,
  stageDeployment,
  validScriptName,
} from "./Deployment.ts";
import {
  conditionalPut,
  decode,
  digest,
  encode,
  ensureImmutable,
  equalBytes,
  refuse,
} from "./Deployment/Objects.ts";
import {
  BOOTSTRAP_MARKER_KEY,
  BootstrapDescriptorSchema,
  ROOT_POINTER_KEY,
} from "./Deployment/Publication.ts";
import { FleetStorage, type Store } from "./FleetStorage.ts";
import type { FleetBucket } from "./Host.ts";
import type { Providers } from "./Providers.ts";

export interface BootstrapProps {
  /** Existing backing bucket; no Fleet or compute dependency is required. */
  readonly bucket: FleetBucket;
  /** Exact supported runtime version. In-place legacy migrations are refused. */
  readonly runtimeVersion: string;
}
export interface BootstrapAttributes extends BootstrapProps {
  /** Deterministic bootstrap artifact version; compute must depend on this output. */
  readonly version: string;
  /** Persisted bootstrap descriptor key. */
  readonly descriptorKey: string;
  /** Observed root, which may already select a real Application. */
  readonly root: Node.DeployPointer;
  /** The descriptor and root deployment were observed complete. */
  readonly ready: true;
}
export interface Bootstrap extends Resource<
  "Celld.Bootstrap",
  BootstrapProps,
  BootstrapAttributes,
  never,
  Providers
> {}

/**
 * Prepare a retained v0.5 startup deployment before fleet compute starts.
 * An existing root is read and preserved, never replaced by the bootstrap.
 *
 * ### Bootstrapping a Bucket
 * **Example:** Order compute after the startup artifact
 * ```typescript
 * const bootstrap = yield* Celld.Bootstrap("Bootstrap", {
 *   bucket: { uri: "s3://my-fleet", region: "us-east-1" },
 *   runtimeVersion: "0.5.0",
 * });
 * // Pass bootstrap.version into the host's compute resource properties.
 * ```
 *
 * @resource
 * @product Celld
 */
export const Bootstrap = Resource<Bootstrap>("Celld.Bootstrap");

/** Prepared local v0.5 fixture, also suitable for the host's live startup test. */
export const prepareBootstrap = (props: BootstrapProps) =>
  Effect.gen(function* () {
    if (props.runtimeVersion !== "0.5.0")
      return yield* refuse(
        "unsupported",
        "Bootstrap supports exactly Celld 0.5.0. Runtime migrations, including direct 0.1 upgrades, require an operator migration.",
      );
    if (!/^s3:\/\/[^/]+$/.test(props.bucket.uri))
      return yield* refuse(
        "configuration",
        "Bootstrap requires a bucket-only s3:// URI.",
      );
    return yield* prepareDeployment({
      scriptName: "alchemy-bootstrap",
      mainModule: "index.js",
      modules: [
        {
          name: "index.js",
          content:
            'export default { fetch() { return new Response("Celld is ready; no Application is published.", { status: 503 }); } };\n',
        },
      ],
      metadata: {
        main_module: "index.js",
        compatibility_date: "2026-09-01",
        bindings: [],
        migrations: {
          new_sqlite_classes: ["__D1Database", "__KvNamespace", "__Queue"],
        },
      },
      doClasses: [],
      sqliteClasses: [],
      systemClasses: ["d1", "kv", "queues"],
    });
  });

const observeRoot = (store: Store) =>
  Effect.gen(function* () {
    const object = yield* store.get(ROOT_POINTER_KEY);
    if (!object) return undefined;
    const pointer = yield* decode(Node.DeployPointer, object.body);
    if (
      !pointer.script_name ||
      !validScriptName(pointer.script_name) ||
      !/^[a-f0-9]{16}$/.test(pointer.version) ||
      pointer.prefix !== `deploy/${pointer.script_name}/${pointer.version}` ||
      pointer.rollout.percent !== 100
    )
      return yield* refuse(
        "unsupported",
        "Existing root is not a complete supported v0.5 deployment pointer; refusing automatic migration.",
      );
    const manifestObject = yield* store.get(`${pointer.prefix}/manifest.json`);
    if (!manifestObject)
      return yield* refuse(
        "invalid-record",
        "Existing root has no deployment manifest.",
      );
    const manifest = yield* decode(Node.Manifest, manifestObject.body);
    if (
      ![1, 2].includes(manifest.schema_version ?? 0) ||
      manifest.version !== pointer.version ||
      manifest.script_name !== pointer.script_name
    )
      return yield* refuse(
        "unsupported",
        "Existing root requires migration or has inconsistent identity; bootstrap will not overwrite it.",
      );
    if (
      manifest.main_module
        ? !manifest.modules.some(
            (module) => module.name === manifest.main_module && !module.kind,
          )
        : !manifest.assets
    )
      return yield* refuse(
        "invalid-record",
        "Existing root has neither a valid entry module nor an asset-only index.",
      );
    if (
      new Set(manifest.modules.map((module) => module.name)).size !==
      manifest.modules.length
    )
      return yield* refuse(
        "invalid-record",
        "Existing root repeats module paths.",
      );
    const supported = [
      "assets-v1",
      "containers-v1",
      "cron-v1",
      "d1-v1",
      "kv-v1",
      "queues-v1",
      "sqlite-vec-v1",
      "r2-v1",
      "wasm-v1",
      "workflows-v1",
    ];
    if (
      manifest.required_features?.some(
        (feature) => !supported.includes(feature),
      )
    )
      return yield* refuse(
        "unsupported",
        "Existing root requires runtime features newer than v0.5.0.",
      );
    for (const module of manifest.modules) {
      if (
        !module.name ||
        module.name
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        module.name.includes("\\") ||
        module.name.includes("\0")
      )
        return yield* refuse(
          "invalid-record",
          "Existing manifest has an unsafe module path.",
        );
      const body = yield* store.get(`${pointer.prefix}/${module.name}`);
      if (
        !body ||
        body.body.length !== module.bytes ||
        ![16, 64].includes(module.sha256.length) ||
        !(yield* digest(body.body)).startsWith(module.sha256)
      )
        return yield* refuse(
          "invalid-record",
          "Existing root has missing or corrupt module bytes.",
        );
    }
    if (manifest.assets) {
      if (manifest.assets.index !== "assets.json")
        return yield* refuse(
          "invalid-record",
          "Existing root has an unsafe asset index reference.",
        );
      const object = yield* store.get(`${pointer.prefix}/assets.json`);
      if (!object || (yield* digest(object.body)) !== manifest.assets.sha256)
        return yield* refuse(
          "invalid-record",
          "Existing root has a missing or corrupt asset index.",
        );
      const index = yield* decode(Node.AssetIndex, object.body);
      const entries = Object.values(index.entries);
      if (
        index.schema_version !== 1 ||
        entries.length !== manifest.assets.file_count ||
        entries.reduce((size, entry) => size + (entry?.bytes ?? 0), 0) !==
          manifest.assets.total_bytes
      )
        return yield* refuse(
          "invalid-record",
          "Existing root has inconsistent asset index statistics.",
        );
      for (const entry of entries) {
        if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256))
          return yield* refuse(
            "invalid-record",
            "Existing root has an invalid asset blob identity.",
          );
        const blob = yield* store.get(
          `deploy-blobs/assets/sha256/${entry.sha256.slice(0, 2)}/${entry.sha256}`,
        );
        if (
          !blob ||
          blob.body.length !== entry.bytes ||
          (yield* digest(blob.body)) !== entry.sha256
        )
          return yield* refuse(
            "invalid-record",
            "Existing root has missing or corrupt asset bytes.",
          );
      }
    }
    return pointer;
  });

const expectedDescriptor = (
  props: BootstrapProps,
  pointer: Node.DeployPointer,
) => ({
  schemaVersion: 1 as const,
  runtimeVersion: "0.5.0" as const,
  bucket: props.bucket,
  pointer,
});

/** Read the marker and actual root; persisted resource output alone never establishes readiness. */
export const readBootstrap = (store: Store, props: BootstrapProps) =>
  Effect.gen(function* () {
    const prepared = yield* prepareBootstrap(props);
    const descriptor = yield* store.get(BOOTSTRAP_MARKER_KEY);
    if (!descriptor) return undefined;
    const observed = yield* decode(BootstrapDescriptorSchema, descriptor.body);
    if (
      !(yield* equalBytes(
        yield* encode(observed),
        yield* encode(expectedDescriptor(props, prepared.pointer)),
      ))
    )
      return yield* refuse(
        "unsupported",
        "Bootstrap descriptor differs; runtime or bucket migration must be performed explicitly.",
      );
    const root = yield* observeRoot(store);
    if (!root) return undefined;
    return {
      ...props,
      version: prepared.version,
      descriptorKey: BOOTSTRAP_MARKER_KEY,
      root,
      ready: true as const,
    };
  });

/** Observe, ensure immutable artifacts, then conditionally initialize missing pointers only. */
export const ensureBootstrap = (store: Store, props: BootstrapProps) =>
  Effect.gen(function* () {
    const prepared = yield* prepareBootstrap(props);
    yield* observeRoot(store);
    yield* ensureImmutable(
      store,
      BOOTSTRAP_MARKER_KEY,
      yield* encode(expectedDescriptor(props, prepared.pointer)),
    );
    yield* stageDeployment(store, prepared);
    const namedKey = `deploy/${prepared.scriptName}/current.json`;
    const named = yield* store.get(namedKey);
    if (!named)
      yield* conditionalPut(
        store,
        namedKey,
        yield* encode(prepared.pointer),
      ).pipe(
        Effect.catchTag("Celld.FleetStorageError", (error) =>
          Effect.gen(function* () {
            if (error.reason !== "conflict" || !(yield* store.get(namedKey)))
              return yield* Effect.fail(error);
          }),
        ),
      );
    const root = yield* store.get(ROOT_POINTER_KEY);
    if (!root)
      yield* conditionalPut(
        store,
        ROOT_POINTER_KEY,
        yield* encode(prepared.pointer),
      ).pipe(
        Effect.catchTag("Celld.FleetStorageError", (error) =>
          Effect.gen(function* () {
            if (
              error.reason !== "conflict" ||
              !(yield* store.get(ROOT_POINTER_KEY))
            )
              return yield* Effect.fail(error);
          }),
        ),
      );
    const ready = yield* readBootstrap(store, props);
    if (!ready)
      return yield* refuse(
        "invalid-record",
        "Bootstrap root disappeared before readiness was observed.",
      );
    return ready;
  });

export const BootstrapProvider = () =>
  Provider.succeed(Bootstrap, {
    stables: ["version", "descriptorKey"],
    diff: Effect.fn(function* ({ news, olds }) {
      if (isResolved(news) && !deepEqual(news.bucket, olds.bucket))
        return { action: "replace" } as const;
    }),
    read: Effect.fn(function* ({ olds }) {
      const storage = yield* FleetStorage;
      return yield* readBootstrap(
        yield* storage({ bucket: olds.bucket }),
        olds,
      );
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const storage = yield* FleetStorage;
      return yield* ensureBootstrap(
        yield* storage({ bucket: news.bucket }),
        news,
      );
    }),
    delete: () => Effect.void,
  });
