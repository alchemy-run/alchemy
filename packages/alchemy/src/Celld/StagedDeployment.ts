import * as Node from "@distilled.cloud/celld/node";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  prepareDeployment,
  sameImmutableManifest,
  validDeploymentPath,
  validScriptName,
  type DeploymentAssets,
} from "./Deployment.ts";
import {
  containerArtifactsKey,
  ContainerArtifactsSchema,
  verifyStoredContainerArtifacts,
} from "./Deployment/Containers.ts";
import {
  decode,
  digest,
  encode,
  equalBytes,
  refuse,
  validate,
} from "./Deployment/Objects.ts";
import type { Store } from "./FleetStorage.ts";

/** Revalidate native modules, assets, container archives and the complete staged prefix. */
export const readStagedDeployment = (store: Store, candidateKey: string) =>
  Effect.gen(function* () {
    const identity =
      /^alchemy\/deployments\/v1\/candidates\/([a-z0-9-]+)\/([a-f0-9]{16})\/([a-f0-9]{64})\.json$/.exec(
        candidateKey,
      );
    if (!identity || !validScriptName(identity[1]!))
      return yield* refuse(
        "configuration",
        "Invalid staged deployment candidate key.",
      );
    const candidate = yield* store.get(candidateKey);
    if (!candidate || (yield* digest(candidate.body)) !== identity[3])
      return yield* refuse(
        "invalid-record",
        "Staged deployment candidate is missing or corrupt.",
      );
    const manifest = yield* decode(Node.Manifest, candidate.body);
    if (
      manifest.script_name !== identity[1] ||
      manifest.version !== identity[2]
    )
      return yield* refuse(
        "invalid-record",
        "Candidate key and manifest deployment identity disagree.",
      );
    if (!manifest.main_module)
      return yield* refuse(
        "unsupported",
        "Alchemy staged workers require a JavaScript entry module.",
      );
    const metadata = yield* validate(
      Schema.Record(Schema.String, Schema.Unknown),
      manifest.raw_metadata,
    );
    const prefix = `deploy/${manifest.script_name}/${manifest.version}`;
    const base = yield* store.get(`${prefix}/manifest.json`);
    if (
      !base ||
      !(yield* sameImmutableManifest(
        yield* decode(Node.Manifest, base.body),
        manifest,
      ))
    )
      return yield* refuse(
        "invalid-record",
        "The staged prefix is incomplete or its immutable manifest differs from the candidate.",
      );
    const modules = yield* Effect.forEach(manifest.modules, (module) =>
      Effect.gen(function* () {
        if (
          !validDeploymentPath(module.name) ||
          !/^[a-f0-9]{64}$/.test(module.sha256) ||
          !Number.isSafeInteger(module.bytes) ||
          module.bytes < 0
        )
          return yield* refuse(
            "invalid-record",
            "Invalid staged module descriptor.",
          );
        const object = yield* store.get(`${prefix}/${module.name}`);
        if (
          !object ||
          object.body.length !== module.bytes ||
          (yield* digest(object.body)) !== module.sha256
        )
          return yield* refuse(
            "invalid-record",
            `Staged module is missing or corrupt: ${module.name}`,
          );
        return {
          name: module.name,
          content: object.body,
          ...(module.kind === "wasm" ? { kind: "wasm" as const } : {}),
        };
      }),
    );
    let assets: DeploymentAssets | undefined;
    if (manifest.assets) {
      if (manifest.assets.index !== "assets.json")
        return yield* refuse(
          "invalid-record",
          "Unsupported staged asset index path.",
        );
      const object = yield* store.get(`${prefix}/assets.json`);
      if (!object || (yield* digest(object.body)) !== manifest.assets.sha256)
        return yield* refuse(
          "invalid-record",
          "Staged asset index is missing or corrupt.",
        );
      const index = yield* decode(Node.AssetIndex, object.body);
      const blobs = yield* Effect.forEach(
        [
          ...new Set(
            Object.values(index.entries).flatMap((entry) =>
              entry ? [entry.sha256] : [],
            ),
          ),
        ],
        (sha256) =>
          Effect.gen(function* () {
            if (!/^[a-f0-9]{64}$/.test(sha256))
              return yield* refuse(
                "invalid-record",
                "Invalid staged asset digest.",
              );
            const blob = yield* store.get(
              `deploy-blobs/assets/sha256/${sha256.slice(0, 2)}/${sha256}`,
            );
            if (!blob)
              return yield* refuse(
                "invalid-record",
                "Missing staged asset blob.",
              );
            return { sha256, body: blob.body };
          }),
      );
      assets = { index, blobs };
    }
    const descriptorObject = yield* store.get(
      containerArtifactsKey(candidateKey),
    );
    if (manifest.containers?.length && !descriptorObject)
      return yield* refuse(
        "invalid-record",
        "Container deployment has no archive verification descriptors.",
      );
    const containerArtifacts = descriptorObject
      ? (yield* decode(ContainerArtifactsSchema, descriptorObject.body))
          .artifacts
      : [];
    yield* verifyStoredContainerArtifacts(store, containerArtifacts);
    const reserved = (name: string) =>
      ["__D1Database", "__KvNamespace", "__Queue"].includes(name) ||
      name.startsWith("__Workflow.");
    const systemClasses: ("d1" | "kv" | "queues")[] = [];
    if (manifest.do_classes.includes("__D1Database")) systemClasses.push("d1");
    if (manifest.do_classes.includes("__KvNamespace")) systemClasses.push("kv");
    if (manifest.do_classes.includes("__Queue")) systemClasses.push("queues");
    const prepared = yield* prepareDeployment({
      scriptName: manifest.script_name,
      mainModule: manifest.main_module,
      modules,
      metadata,
      doClasses: manifest.do_classes.filter((name) => !reserved(name)),
      sqliteClasses: manifest.sqlite_classes.filter((name) => !reserved(name)),
      crons: manifest.crons,
      queueConsumers: manifest.queue_consumers,
      containers: manifest.containers,
      fenceImage: manifest.fence_image,
      containerArtifacts,
      assets,
      systemClasses,
    });
    if (
      prepared.candidate.key !== candidateKey ||
      !(yield* equalBytes(yield* encode(prepared.manifest), candidate.body))
    )
      return yield* refuse(
        "invalid-record",
        "Staged deployment does not reproduce its native content identity.",
      );
    if (
      descriptorObject &&
      (!prepared.artifactDescriptor ||
        !(yield* equalBytes(
          prepared.artifactDescriptor.body,
          descriptorObject.body,
        )))
    )
      return yield* refuse(
        "invalid-record",
        "Container descriptors do not reproduce their canonical identity.",
      );
    return prepared;
  });
