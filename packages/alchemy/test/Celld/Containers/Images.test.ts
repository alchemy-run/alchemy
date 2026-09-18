import {
  assertContainerUpdateSafe,
  bundleGeneratedContainer,
  generatedContainerEntry,
  validateContainerDeclarations,
  validateContainerHost,
  type PreparedContainer,
} from "@/Celld/Containers/Images.ts";
import { prepareDeployment, stageDeployment } from "@/Celld/Deployment.ts";
import {
  containerArchiveRecoveryKey,
  containerImageRecordKey,
  stageContainerArtifacts,
  verifyStoredContainerArtifacts,
} from "@/Celld/Deployment/Containers.ts";
import { bytes, digest, encode } from "@/Celld/Deployment/Objects.ts";
import { makeStore } from "../DeploymentStore.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

// Docker save configs differ in creation metadata without changing inspect Config or layers.
const savedArchives = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "celld-archive-fixtures-",
  });
  const config = { Env: ["ALCHEMY_CONTAINER_TEST=1"] };
  const identity = yield* digest(yield* bytes(`[]${JSON.stringify(config)}`));
  const image = `celld-image:${identity}`;
  return yield* Effect.forEach(
    ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
    (created, index) =>
      Effect.gen(function* () {
        const directory = path.join(root, String(index));
        yield* fs.makeDirectory(directory);
        const imageConfig = yield* encode({
          created,
          architecture: "arm64",
          os: "linux",
          config,
          rootfs: { type: "layers", diff_ids: [] },
          history: [],
        });
        const configName = `${yield* digest(imageConfig)}.json`;
        yield* fs.writeFile(path.join(directory, configName), imageConfig);
        yield* fs.writeFile(
          path.join(directory, "manifest.json"),
          yield* encode([
            { Config: configName, RepoTags: [image], Layers: [] },
          ]),
        );
        const archive = path.join(root, `${index}.tar`);
        yield* spawner.string(
          ChildProcess.make("tar", [
            "-cf",
            archive,
            "-C",
            directory,
            "manifest.json",
            configName,
          ]),
        );
        const body = yield* fs.readFile(archive);
        return {
          image,
          key: `deploy/images/${identity}.tar`,
          sha256: yield* digest(body),
          bytes: body.length,
          body,
        };
      }),
  );
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const old: PreparedContainer = {
  class_name: "Agent",
  image: `celld-image:${"a".repeat(64)}`,
  runtime: "runsc",
  instance_type: "dev",
  max_instances: 4,
};

describe("Celld first-archive publication", () => {
  it.effect(
    "reuses the first verified save and candidate descriptor for equivalent rebuilds",
    () =>
      Effect.gen(function* () {
        const [first, second] = yield* savedArchives;
        expect(first!.image).toBe(second!.image);
        expect(first!.sha256).not.toBe(second!.sha256);
        const fake = yield* makeStore;
        const original = yield* stageContainerArtifacts(fake.store, [first!]);
        const writes = [...fake.writes];
        const reused = yield* stageContainerArtifacts(fake.store, [second!]);
        expect(reused).toEqual(original);
        expect(fake.writes).toEqual(writes);
        expect(fake.objects.get(first!.key)?.body).toEqual(first!.body);
        const prepare = (containerArtifacts: typeof original) =>
          prepareDeployment({
            scriptName: "container-reuse",
            mainModule: "worker.js",
            modules: [{ name: "worker.js", content: "export class Tool {}" }],
            metadata: {
              main_module: "worker.js",
              compatibility_date: "2026-09-01",
              compatibility_flags: [],
              bindings: [],
            },
            doClasses: ["Tool"],
            sqliteClasses: ["Tool"],
            containers: [{ class_name: "Tool", image: first!.image }],
            fenceImage: first!.image,
            containerArtifacts,
          });
        const initial = yield* prepare(original);
        yield* stageDeployment(fake.store, initial);
        const next = yield* prepare(reused);
        yield* stageDeployment(fake.store, next);
        expect(next.artifactDescriptor).toEqual(initial.artifactDescriptor);
        expect(next.candidate).toEqual(initial.candidate);
        expect(
          Result.isFailure(
            yield* Effect.result(
              verifyStoredContainerArtifacts(fake.store, [second!]),
            ),
          ),
        ).toBe(true);
      }),
  );

  it.effect(
    "recovers interrupted native uploads from the first archive, even after a different rebuild",
    () =>
      Effect.gen(function* () {
        const [first, second] = yield* savedArchives;
        const fake = yield* makeStore;
        fake.failBefore.add(first!.key);
        expect(
          Result.isFailure(
            yield* Effect.result(stageContainerArtifacts(fake.store, [first!])),
          ),
        ).toBe(true);
        expect(fake.objects.has(first!.key)).toBe(false);
        const selected = yield* stageContainerArtifacts(fake.store, [second!]);
        expect(selected[0]?.sha256).toBe(first!.sha256);
        expect(fake.objects.get(first!.key)?.body).toEqual(first!.body);
      }),
  );

  it.effect(
    "recovers lost responses at every immutable publication boundary",
    () =>
      Effect.gen(function* () {
        const [first] = yield* savedArchives;
        for (const key of [
          containerArchiveRecoveryKey(first!.sha256),
          containerImageRecordKey(first!.image),
          first!.key,
        ]) {
          const fake = yield* makeStore;
          fake.loseResponse.add(key);
          const selected = yield* stageContainerArtifacts(fake.store, [first!]);
          expect(selected[0]?.sha256).toBe(first!.sha256);
          yield* verifyStoredContainerArtifacts(fake.store, selected);
        }
      }),
  );

  it.effect(
    "accepts only the conditional provenance winner when different archives race",
    () =>
      Effect.gen(function* () {
        const [first, second] = yield* savedArchives;
        const winner = yield* makeStore;
        const selected = yield* stageContainerArtifacts(winner.store, [first!]);
        const fake = yield* makeStore;
        const key = containerImageRecordKey(first!.image);
        fake.race.set(key, () => {
          for (const [key, object] of winner.objects)
            fake.objects.set(key, object);
        });
        expect(yield* stageContainerArtifacts(fake.store, [second!])).toEqual(
          selected,
        );
        expect(fake.objects.get(first!.key)?.body).toEqual(first!.body);
        expect(fake.writes).not.toContain(first!.key);
      }),
  );

  it.effect(
    "refuses unmanaged archives and native-key races without overwriting them",
    () =>
      Effect.gen(function* () {
        const [first, second] = yield* savedArchives;
        const fake = yield* makeStore;
        yield* fake.store.put(first!.key, first!.body);
        const before = [...fake.writes];
        const refused = yield* Effect.result(
          stageContainerArtifacts(fake.store, [second!]),
        );
        expect(
          Result.isFailure(refused) &&
            refused.failure._tag === "Celld.DeploymentError" &&
            refused.failure.reason,
        ).toBe("ownership");
        expect(fake.writes).toEqual(before);
        const raced = yield* makeStore;
        raced.race.set(first!.key, () =>
          raced.objects.set(first!.key, {
            body: second!.body,
            etag: "foreign",
          }),
        );
        expect(
          Result.isFailure(
            yield* Effect.result(
              stageContainerArtifacts(raced.store, [first!]),
            ),
          ),
        ).toBe(true);
        expect(raced.objects.get(first!.key)?.body).toEqual(second!.body);
      }),
  );

  it.effect(
    "refuses corrupt native archives, missing or corrupt provenance, and mismatched candidate descriptors",
    () =>
      Effect.gen(function* () {
        const [first, second] = yield* savedArchives;
        for (const corruption of [
          "body",
          "missing-record",
          "invalid-record",
          "wrong-image",
          "wrong-size",
          "wrong-checksum",
        ] as const) {
          const fake = yield* makeStore;
          const selected = yield* stageContainerArtifacts(fake.store, [first!]);
          const key = containerImageRecordKey(first!.image);
          if (corruption === "body")
            yield* fake.store.put(first!.key, second!.body);
          else if (corruption === "missing-record")
            yield* fake.store.delete(key);
          else if (corruption === "invalid-record")
            yield* fake.store.put(key, yield* bytes("invalid"));
          else {
            const artifact = {
              ...selected[0]!,
              ...(corruption === "wrong-image"
                ? {
                    image: `celld-image:${"f".repeat(64)}`,
                    key: `deploy/images/${"f".repeat(64)}.tar`,
                  }
                : corruption === "wrong-size"
                  ? { bytes: first!.bytes + 1 }
                  : { sha256: "f".repeat(64) }),
            };
            yield* fake.store.put(
              key,
              yield* encode({ schemaVersion: 1, artifact }),
            );
          }
          const before = [...fake.writes];
          expect(
            Result.isFailure(
              yield* Effect.result(
                stageContainerArtifacts(fake.store, [second!]),
              ),
            ),
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                verifyStoredContainerArtifacts(fake.store, selected),
              ),
            ),
          ).toBe(true);
          expect(fake.writes).toEqual(before);
        }
      }),
  );

  it.effect(
    "does not repair interrupted publication from missing or corrupt recovery bytes",
    () =>
      Effect.gen(function* () {
        const [first, second] = yield* savedArchives;
        for (const missing of [true, false]) {
          const fake = yield* makeStore;
          fake.failBefore.add(first!.key);
          yield* Effect.result(stageContainerArtifacts(fake.store, [first!]));
          const recovery = containerArchiveRecoveryKey(first!.sha256);
          if (missing) yield* fake.store.delete(recovery);
          else yield* fake.store.put(recovery, second!.body);
          expect(
            Result.isFailure(
              yield* Effect.result(
                stageContainerArtifacts(fake.store, [second!]),
              ),
            ),
          ).toBe(true);
          expect(fake.objects.has(first!.key)).toBe(false);
        }
      }),
  );
});

describe("Celld container image contracts", () => {
  it.effect(
    "allows unchanged specs and new classes, but rejects unsafe cache mutations and removal",
    () =>
      Effect.gen(function* () {
        yield* assertContainerUpdateSafe(
          [old],
          [{ ...old }, { ...old, class_name: "Another" }],
        );
        for (const next of [
          [],
          [{ ...old, image: "celld-image:new" }],
          [{ ...old, runtime: "runc" }],
          [{ ...old, max_instances: 5 }],
        ]) {
          const result = yield* Effect.result(
            assertContainerUpdateSafe([old], next),
          );
          expect(Result.isFailure(result) && result.failure._tag).toBe(
            "Celld.ContainerUpdateRequiresQuiescence",
          );
        }
      }),
  );

  it.effect(
    "coalesces duplicate bindings and refuses competing images on one class",
    () =>
      Effect.gen(function* () {
        const declaration = {
          className: "Agent",
          name: "Tool",
          image: "alpine:3.20",
          ociRuntime: "runsc",
        };
        expect(
          yield* validateContainerDeclarations([
            declaration,
            { ...declaration, name: "Alias" },
          ]),
        ).toHaveLength(1);
        const conflict = yield* Effect.result(
          validateContainerDeclarations([
            declaration,
            { ...declaration, image: "busybox" },
          ]),
        );
        expect(Result.isFailure(conflict) && conflict.failure._tag).toBe(
          "Celld.ContainerConfigurationError",
        );
        const invalid = yield* Effect.result(
          validateContainerDeclarations([{ ...declaration, maxInstances: -1 }]),
        );
        expect(Result.isFailure(invalid)).toBe(true);
      }),
  );

  it.effect(
    "validates same-script SQLite classes and host architecture before Docker",
    () =>
      Effect.gen(function* () {
        const declaration = {
          name: "Tool",
          className: "Agent",
          image: "alpine:3.20",
          ociRuntime: "runsc",
        };
        const hostState = {
          capabilities: { containers: true },
          configuration: {
            capacity: "ec2",
            cpuArchitecture: "ARM64",
            containerRuntime: "runsc",
          },
        };
        const options = {
          declarations: [declaration],
          doClasses: ["Agent"],
          sqliteClasses: ["Agent"],
          hostState,
        };
        expect((yield* validateContainerHost(options)).platform).toBe(
          "linux/arm64",
        );
        expect(
          (yield* validateContainerHost({
            ...options,
            hostState: {
              ...hostState,
              configuration: {
                architecture: "X86_64",
                containerRuntime: "runsc",
              },
            },
          })).platform,
        ).toBe("linux/amd64");
        expect(
          yield* validateContainerHost({
            declarations: [],
            doClasses: [],
            sqliteClasses: [],
          }),
        ).toEqual({ declarations: [], platform: undefined });
        for (const invalid of [
          { ...options, hostState: undefined },
          {
            ...options,
            hostState: { ...hostState, capabilities: { containers: false } },
          },
          {
            ...options,
            hostState: {
              ...hostState,
              configuration: {
                ...hostState.configuration,
                capacity: "fargate",
              },
            },
          },
          {
            ...options,
            hostState: {
              ...hostState,
              configuration: {
                ...hostState.configuration,
                cpuArchitecture: undefined,
              },
            },
          },
          {
            ...options,
            hostState: {
              ...hostState,
              configuration: {
                ...hostState.configuration,
                cpuArchitecture: "unsupported",
              },
            },
          },
          { ...options, doClasses: [] },
          { ...options, sqliteClasses: [] },
          {
            ...options,
            declarations: [{ ...declaration, ociRuntime: "unconfigured" }],
          },
        ]) {
          const result = yield* Effect.result(validateContainerHost(invalid));
          expect(Result.isFailure(result) && result.failure._tag).toBe(
            "Celld.ContainerConfigurationError",
          );
        }
      }),
  );

  it("selects language-specific bootstraps without treating runsc as a language", () => {
    expect(generatedContainerEntry("./main.ts", "bun")).toContain(
      "BunRuntime.runMain",
    );
    expect(generatedContainerEntry("./main.ts", "node")).toContain(
      "NodeRuntime.runMain",
    );
    expect(generatedContainerEntry("./main.ts", "node")).not.toContain("runsc");
    expect(generatedContainerEntry("./main.ts", "bun")).toContain(
      "Effect.scoped",
    );
  });

  for (const runtime of ["bun", "node"] as const) {
    it.effect(
      `bundles the class/make fixture for ${runtime} with all chunks`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "celld-container-bundle-test-",
          });
          const main = yield* Effect.sync(
            () => new URL("./fixtures/Tool.runtime.ts", import.meta.url).href,
          );
          const bundle = yield* bundleGeneratedContainer(
            { main, runtime, ociRuntime: "runsc" },
            directory,
          );
          expect(bundle.files.length).toBeGreaterThan(0);
          expect(bundle.files.some((file) => file.path === "index.mjs")).toBe(
            true,
          );
          const emitted = bundle.files
            .map((file) =>
              typeof file.content === "string"
                ? file.content
                : new TextDecoder().decode(file.content),
            )
            .join("\n");
          expect(emitted).toContain("celld generated container");
          expect(emitted).not.toContain("cloudflare:workers");
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
      { timeout: 120_000 },
    );
  }
});
