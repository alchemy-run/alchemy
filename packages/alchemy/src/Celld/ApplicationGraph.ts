import * as Node from "@distilled.cloud/celld/node";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { prepareDeployment, type PreparedDeployment } from "./Deployment.ts";
import {
  decode,
  digest,
  encode,
  refuse,
  validate,
} from "./Deployment/Objects.ts";

export const APPLICATION_GRAPH_METADATA = "alchemy_application";
export const APPLICATION_GRAPH_BINDING_PREFIX = "__ALCHEMY_APP_WORKER_";
export const APPLICATION_OPERATOR_CLASSES = [
  "__D1Database",
  "__KvNamespace",
  "__Queue",
];
export const APPLICATION_OPERATOR_FEATURES = ["d1-v1", "kv-v1", "queues-v1"];

/** Bind secondary Worker and schedule revisions into the root's native content identity. */
export const prepareApplicationGraph = (
  root: PreparedDeployment,
  workers: readonly PreparedDeployment[],
) =>
  Effect.gen(function* () {
    const metadata = yield* validate(
      Schema.Record(Schema.String, Schema.Unknown),
      root.manifest.raw_metadata,
    );
    if (metadata[APPLICATION_GRAPH_METADATA] !== undefined)
      return yield* refuse(
        "configuration",
        "Worker metadata uses the reserved Application graph field.",
      );
    const bindings = yield* validate(
      Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      metadata.bindings ?? [],
    );
    if (
      bindings.some(
        (binding) =>
          typeof binding.name === "string" &&
          binding.name.startsWith(APPLICATION_GRAPH_BINDING_PREFIX),
      )
    )
      return yield* refuse(
        "configuration",
        "Worker bindings use the reserved Application graph prefix.",
      );
    const ordered = [...workers].sort((a, b) =>
      a.scriptName.localeCompare(b.scriptName),
    );
    const candidates = [root, ...ordered].map((worker) => ({
      scriptName: worker.scriptName,
      key: worker.candidate.key,
    }));
    const revision = yield* digest(yield* encode(candidates));
    const assetsObject = root.objects.find(
      (object) => object.key === `${root.prefix}/assets.json`,
    );
    const assets = assetsObject
      ? {
          index: yield* decode(Node.AssetIndex, assetsObject.body),
          blobs: root.assetObjects.map((object) => ({
            sha256: object.key.slice(object.key.lastIndexOf("/") + 1),
            body: object.body,
          })),
        }
      : undefined;
    if (!root.manifest.main_module)
      return yield* refuse(
        "unsupported",
        "Application entrypoints require a JavaScript module.",
      );
    const modules = yield* Effect.forEach(root.manifest.modules, (module) =>
      Effect.gen(function* () {
        const object = root.objects.find(
          (object) => object.key === `${root.prefix}/${module.name}`,
        );
        if (!object)
          return yield* refuse(
            "invalid-record",
            "Application root is missing staged module bytes.",
          );
        return {
          name: module.name,
          content: object.body,
          ...(module.kind === "wasm" ? { kind: "wasm" as const } : {}),
        };
      }),
    );
    const builtin = (name: string) =>
      APPLICATION_OPERATOR_CLASSES.includes(name) ||
      name.startsWith("__Workflow.");
    const prepared = yield* prepareDeployment({
      scriptName: root.scriptName,
      mainModule: root.manifest.main_module,
      modules,
      metadata: {
        ...metadata,
        [APPLICATION_GRAPH_METADATA]: {
          schemaVersion: 1,
          operatorClasses: APPLICATION_OPERATOR_CLASSES,
          revision,
          candidates,
        },
        bindings: [
          ...bindings,
          ...ordered.map((worker, index) => ({
            type: "service",
            name: `${APPLICATION_GRAPH_BINDING_PREFIX}${index}`,
            service: worker.scriptName,
          })),
        ],
      },
      doClasses: root.manifest.do_classes.filter((name) => !builtin(name)),
      sqliteClasses: root.manifest.sqlite_classes.filter(
        (name) => !builtin(name),
      ),
      queueConsumers: root.manifest.queue_consumers,
      crons: root.manifest.crons,
      assets,
      containers: root.manifest.containers,
      fenceImage: root.manifest.fence_image,
      containerArtifacts: root.containerArtifacts,
      // Standalone resources outlive Worker bindings; only the root needs fallback operators.
      systemClasses: ["d1", "kv", "queues"],
    });
    return { root: prepared, workers: ordered, revision };
  });
