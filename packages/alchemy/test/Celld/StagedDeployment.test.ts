import { prepareBootstrap } from "@/Celld/Bootstrap.ts";
import {
  APPLICATION_LOCK_KEY,
  APPLICATION_RECEIPT_KEY,
  prepareDeployment,
  publishApplication,
  stageAssetBlobs,
  stageContainerArtifacts,
  stageDeployment,
  type PrepareDeploymentInput,
} from "@/Celld/Deployment.ts";
import { containerArtifactsKey } from "@/Celld/Deployment/Containers.ts";
import { bytes, digest } from "@/Celld/Deployment/Objects.ts";
import { readStagedDeployment } from "@/Celld/StagedDeployment.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeStore } from "./DeploymentStore.ts";

const input: PrepareDeploymentInput = {
  scriptName: "staged",
  mainModule: "index.js",
  modules: [
    {
      name: "index.js",
      content:
        'export class Box {} export default { fetch() { return new Response("ok"); } };',
    },
  ],
  metadata: { main_module: "index.js", bindings: [] },
  doClasses: [],
  sqliteClasses: [],
};
const owner = { stack: "Staged", stage: "test", fqn: "App", instanceId: "one" };
const archives = Effect.gen(function* () {
  const imageId = "a".repeat(64);
  const fenceId = "b".repeat(64);
  const make = (id: string, source: string) =>
    Effect.gen(function* () {
      // Synthetic bytes exercise storage integrity, not Docker archive compatibility.
      const body = yield* bytes(source);
      return {
        image: `celld-image:${id}`,
        key: `deploy/images/${id}.tar`,
        sha256: yield* digest(body),
        bytes: body.length,
        body,
      };
    });
  return [
    yield* make(imageId, "application-archive-fixture"),
    yield* make(fenceId, "fence-archive-fixture"),
  ];
});
const containerInput = (
  artifacts: Effect.Success<typeof archives>,
): PrepareDeploymentInput => ({
  ...input,
  doClasses: ["Box"],
  sqliteClasses: ["Box"],
  containers: [
    { class_name: "Box", image: artifacts[0]!.image, instance_type: "dev" },
  ],
  fenceImage: artifacts[1]!.image,
  containerArtifacts: artifacts,
});

describe("Celld staged deployment verification", () => {
  test.effect(
    "reconstructs native modules and rejects missing or modified content",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment(input);
        yield* stageDeployment(fake.store, prepared);
        expect(
          (yield* readStagedDeployment(fake.store, prepared.candidate.key))
            .manifest,
        ).toEqual(prepared.manifest);
        yield* fake.store.put(
          prepared.objects[0]!.key,
          yield* bytes("corrupted"),
        );
        expect(
          Result.isFailure(
            yield* Effect.result(
              readStagedDeployment(fake.store, prepared.candidate.key),
            ),
          ),
        ).toBe(true);
        yield* fake.store.delete(prepared.objects[0]!.key);
        expect(
          Result.isFailure(
            yield* Effect.result(
              readStagedDeployment(fake.store, prepared.candidate.key),
            ),
          ),
        ).toBe(true);
      }),
  );

  test.effect(
    "validates candidate identity and requires the complete native prefix",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment(input);
        yield* stageDeployment(fake.store, prepared);
        const transplanted = prepared.candidate.key.replace(
          "/staged/",
          "/other/",
        );
        yield* fake.store.put(transplanted, prepared.candidate.body);
        expect(
          Result.isFailure(
            yield* Effect.result(
              readStagedDeployment(fake.store, transplanted),
            ),
          ),
        ).toBe(true);
        yield* fake.store.delete(`${prepared.prefix}/manifest.json`);
        expect(
          Result.isFailure(
            yield* Effect.result(
              readStagedDeployment(fake.store, prepared.candidate.key),
            ),
          ),
        ).toBe(true);
      }),
  );

  test.effect(
    "reconstructs a cron-only candidate without overwriting the live base manifest",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const base = yield* prepareDeployment(input);
        yield* stageDeployment(fake.store, base);
        const before = fake.objects.get(`${base.prefix}/manifest.json`)!.etag;
        const candidate = yield* prepareDeployment({
          ...input,
          crons: ["0 * * * *"],
        });
        yield* stageDeployment(fake.store, candidate);
        expect(
          (yield* readStagedDeployment(fake.store, candidate.candidate.key))
            .manifest.crons,
        ).toEqual(["0 * * * *"]);
        expect(fake.objects.get(`${base.prefix}/manifest.json`)!.etag).toBe(
          before,
        );
      }),
  );

  test.effect(
    "reconstructs bootstrap-only reserved classes without inventing environment bindings",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareBootstrap({
          bucket: { uri: "s3://bootstrap" },
          runtimeVersion: "0.5.0",
        });
        yield* stageDeployment(fake.store, prepared);
        expect(
          (yield* readStagedDeployment(fake.store, prepared.candidate.key))
            .manifest,
        ).toEqual(prepared.manifest);
      }),
  );

  test.effect(
    "verifies native asset index statistics and raw asset bodies",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const body = yield* bytes("asset");
        const sha256 = yield* digest(body);
        const prepared = yield* prepareDeployment({
          ...input,
          assets: {
            index: {
              schema_version: 1,
              entries: { "/asset.txt": { sha256, bytes: body.length } },
              config: {},
            },
            blobs: [{ sha256, body }],
          },
        });
        yield* stageAssetBlobs(fake.store, prepared);
        yield* stageDeployment(fake.store, prepared);
        expect(
          (yield* readStagedDeployment(fake.store, prepared.candidate.key))
            .manifest.assets,
        ).toEqual(prepared.manifest.assets);
        yield* fake.store.put(
          prepared.assetObjects[0]!.key,
          yield* bytes("wrong"),
        );
        expect(
          Result.isFailure(
            yield* Effect.result(
              readStagedDeployment(fake.store, prepared.candidate.key),
            ),
          ),
        ).toBe(true);
      }),
  );

  test.effect(
    "requires every archive before staging and preserves native container/fence descriptors",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const artifacts = yield* archives;
        const prepared = yield* prepareDeployment(containerInput(artifacts));
        expect(
          Result.isFailure(
            yield* Effect.result(stageDeployment(fake.store, prepared)),
          ),
        ).toBe(true);
        expect(fake.writes).toEqual([]);
        yield* stageContainerArtifacts(fake.store, artifacts);
        expect(
          Result.isFailure(
            yield* Effect.result(
              stageDeployment(fake.store, {
                ...prepared,
                containerArtifacts: [],
                artifactDescriptor: undefined,
              }),
            ),
          ),
        ).toBe(true);
        yield* stageDeployment(fake.store, prepared);
        expect(prepared.manifest.required_features).toEqual(["containers-v1"]);
        expect(prepared.version).toBe("ccf59ac2cdd726c6");
        expect(prepared.manifest.fence_image).toBe(artifacts[1]!.image);
        expect(
          fake.objects.has(containerArtifactsKey(prepared.candidate.key)),
        ).toBe(true);
        const observed = yield* readStagedDeployment(
          fake.store,
          prepared.candidate.key,
        );
        expect(observed.manifest).toEqual(prepared.manifest);
        expect(observed.containerArtifacts).toEqual(
          prepared.containerArtifacts,
        );
        expect(artifacts[0]!.sha256).not.toBe(
          artifacts[0]!.image.slice("celld-image:".length),
        );
      }),
  );

  test.effect(
    "refuses mismatched archive hashes, image names, keys, fence references and SQLite classes",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const artifacts = yield* archives;
        const supplied = containerInput(artifacts);
        expect(
          Result.isFailure(
            yield* Effect.result(
              stageContainerArtifacts(fake.store, [
                { ...artifacts[0]!, body: yield* bytes("corrupt") },
              ]),
            ),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* Effect.result(
              prepareDeployment({
                ...supplied,
                containerArtifacts: [
                  { ...artifacts[0]!, key: "deploy/images/wrong.tar" },
                  artifacts[1]!,
                ],
              }),
            ),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* Effect.result(
              prepareDeployment({
                ...supplied,
                containerArtifacts: [
                  { ...artifacts[0]!, image: "docker.io/unpinned:latest" },
                  artifacts[1]!,
                ],
              }),
            ),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* Effect.result(
              prepareDeployment({
                ...supplied,
                containerArtifacts: [artifacts[0]!],
              }),
            ),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* Effect.result(
              prepareDeployment({ ...supplied, fenceImage: undefined }),
            ),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* Effect.result(
              prepareDeployment({ ...supplied, sqliteClasses: [] }),
            ),
          ),
        ).toBe(true);
        expect(fake.writes).toEqual([]);
      }),
  );

  test.effect(
    "reuses the first verified archive and rejects missing descriptors or modified stored bytes",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const artifacts = yield* archives;
        const prepared = yield* prepareDeployment(containerInput(artifacts));
        yield* stageContainerArtifacts(fake.store, artifacts);
        yield* stageDeployment(fake.store, prepared);
        const changed = yield* bytes("different archive");
        const replacement = {
          ...artifacts[0]!,
          sha256: yield* digest(changed),
          bytes: changed.length,
          body: changed,
        };
        const selected = yield* stageContainerArtifacts(fake.store, [
          replacement,
        ]);
        expect(selected[0]!.sha256).toBe(artifacts[0]!.sha256);
        expect(selected[0]!.bytes).toBe(artifacts[0]!.bytes);
        expect(fake.objects.get(artifacts[0]!.key)!.body).toEqual(
          artifacts[0]!.body,
        );
        yield* fake.store.put(artifacts[0]!.key, changed);
        expect(
          Result.isFailure(
            yield* Effect.result(
              readStagedDeployment(fake.store, prepared.candidate.key),
            ),
          ),
        ).toBe(true);
        yield* fake.store.put(artifacts[0]!.key, artifacts[0]!.body);
        yield* fake.store.delete(containerArtifactsKey(prepared.candidate.key));
        expect(
          Result.isFailure(
            yield* Effect.result(
              readStagedDeployment(fake.store, prepared.candidate.key),
            ),
          ),
        ).toBe(true);
      }),
  );

  test.effect(
    "refuses removal of an entire Worker with cached containers before any pointer writes",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const artifacts = yield* archives;
        const worker = yield* prepareDeployment(containerInput(artifacts));
        const root = yield* prepareDeployment({ ...input, scriptName: "root" });
        yield* stageContainerArtifacts(fake.store, artifacts);
        const first = yield* publishApplication(fake.store, {
          rootPreparedDeployment: root,
          workers: [worker],
          owner,
          transactionId: "with-container-worker",
        });
        const writes = fake.writes.length;
        const rootPointer = fake.objects.get("deploy/current.json")!;
        const workerPointer = fake.objects.get("deploy/staged/current.json")!;
        const receipt = fake.objects.get(APPLICATION_RECEIPT_KEY)!;
        const removed = yield* Effect.result(
          publishApplication(fake.store, {
            rootPreparedDeployment: root,
            workers: [],
            owner,
            transactionId: "remove-container-worker",
            priorRevision: first.revision,
          }),
        );
        expect(Result.isFailure(removed)).toBe(true);
        if (Result.isFailure(removed)) {
          expect(removed.failure._tag).toBe("Celld.DeploymentError");
          expect(removed.failure.reason).toBe("unsupported");
          expect(removed.failure.message).toContain("operator quiescence");
        }
        expect(fake.objects.get("deploy/current.json")).toEqual(rootPointer);
        expect(fake.objects.get("deploy/staged/current.json")).toEqual(
          workerPointer,
        );
        expect(
          fake.writes
            .slice(writes)
            .filter((key) => key.endsWith("/current.json")),
        ).toEqual([]);
        expect(fake.objects.get(APPLICATION_RECEIPT_KEY)).toEqual(receipt);
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
        expect(
          fake.objects.has(
            "alchemy/application/v1/transactions/remove-container-worker.json",
          ),
        ).toBe(false);
        const reverted = yield* publishApplication(fake.store, {
          rootPreparedDeployment: root,
          workers: [worker],
          owner,
          transactionId: "restore-container-worker",
          priorRevision: first.revision,
        });
        expect(reverted.receipt.workers).toEqual([worker.pointer]);
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
      }),
  );

  test.effect(
    "publishes verified containers but refuses cached-container changes before pointers move",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const artifacts = yield* archives;
        const prepared = yield* prepareDeployment(containerInput(artifacts));
        yield* stageContainerArtifacts(fake.store, artifacts);
        yield* stageDeployment(fake.store, prepared);
        const first = yield* publishApplication(fake.store, {
          rootPreparedDeployment: prepared,
          workers: [],
          owner,
          transactionId: "containers",
        });
        const root = fake.objects.get("deploy/current.json")!.etag;
        const changed = yield* prepareDeployment({
          ...containerInput(artifacts),
          containers: [
            {
              class_name: "Box",
              image: artifacts[0]!.image,
              instance_type: "basic",
            },
          ],
        });
        yield* stageDeployment(fake.store, changed);
        expect(
          Result.isFailure(
            yield* Effect.result(
              publishApplication(fake.store, {
                rootPreparedDeployment: changed,
                workers: [],
                owner,
                transactionId: "unsafe-resize",
                priorRevision: first.revision,
              }),
            ),
          ),
        ).toBe(true);
        expect(fake.objects.get("deploy/current.json")!.etag).toBe(root);
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
        expect(
          fake.objects.has(
            "alchemy/application/v1/transactions/unsafe-resize.json",
          ),
        ).toBe(false);
        const valid = yield* prepareDeployment({
          ...containerInput(artifacts),
          crons: ["0 * * * *"],
        });
        const published = yield* publishApplication(fake.store, {
          rootPreparedDeployment: valid,
          workers: [],
          owner,
          transactionId: "valid-container-update",
          priorRevision: first.revision,
        });
        expect(published.receipt.root).toEqual(valid.pointer);
        expect(published.revision).not.toBe(first.revision);
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
      }),
  );
});
