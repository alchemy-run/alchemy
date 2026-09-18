import { prepareContainerImages } from "@/Celld/Containers/Images.ts";
import type { ContainerDeclaration } from "@/Celld/Containers/Container.ts";
import {
  prepareDeployment,
  stageContainerArtifacts,
  stageDeployment,
} from "@/Celld/Deployment.ts";
import { deploymentMetadata } from "@/Celld/DeploymentConfig.ts";
import { Docker, DockerLive } from "@/Docker/Docker.ts";
import { sha256 } from "@/Util/sha256.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { makeStore } from "../DeploymentStore.ts";

const services = DockerLive.pipe(Layer.provideMerge(BunServices.layer));
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        Config: Schema.String,
        RepoTags: Schema.Array(Schema.String),
      }),
    ),
  ),
);

describe.skipIf(!process.env.CELLD_TEST_DOCKER)(
  "Celld local Docker image publication",
  () => {
    it.effect(
      "exports only the target architecture from a multi-platform image store",
      () =>
        Effect.gen(function* () {
          const docker = yield* Docker;
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner;
          const platforms = ["linux/amd64", "linux/arm64"] as const;
          for (const platform of platforms) {
            yield* docker.image.pull("alpine:3.20", platform);
          }
          for (const platform of platforms) {
            const prepared = yield* prepareContainerImages({
              declarations: [
                { name: "Multi", className: "Tool", image: "alpine:3.20" },
              ],
              platform,
              archiveDirectory: yield* fs.makeTempDirectoryScoped({
                prefix: "celld-platform-",
              }),
            });
            for (const artifact of prepared.images) {
              const entries = yield* spawner
                .string(
                  ChildProcess.make("tar", [
                    "-xOf",
                    artifact.path,
                    "manifest.json",
                  ]),
                )
                .pipe(Effect.flatMap(decodeManifest));
              expect(entries).toHaveLength(1);
              const config = yield* spawner
                .string(
                  ChildProcess.make("tar", [
                    "-xOf",
                    artifact.path,
                    entries[0].Config,
                  ]),
                )
                .pipe(
                  Effect.flatMap(
                    Schema.decodeEffect(
                      Schema.fromJsonString(
                        Schema.Struct({
                          architecture: Schema.String,
                          os: Schema.String,
                        }),
                      ),
                    ),
                  ),
                );
              expect(`${config.os}/${config.architecture}`).toBe(platform);
            }
          }
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 120_000 },
    );
    it.effect(
      "builds and saves a tiny image plus the native fence with separate identity and archive checksums",
      () =>
        Effect.gen(function* () {
          const docker = yield* Docker;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner;
          const architecture = (yield* docker.run([
            "info",
            "--format",
            "{{.Architecture}}",
          ])).stdout;
          if (
            architecture !== "aarch64" &&
            architecture !== "arm64" &&
            architecture !== "x86_64" &&
            architecture !== "amd64"
          ) {
            return yield* Effect.fail(
              new Error(
                `Unsupported local Docker architecture: ${architecture}`,
              ),
            );
          }
          const platform =
            architecture === "aarch64" || architecture === "arm64"
              ? "linux/arm64"
              : "linux/amd64";
          const context = yield* fs.makeTempDirectoryScoped({
            prefix: "celld-tiny-image-test-",
          });
          const archiveDirectory = yield* fs.makeTempDirectoryScoped({
            prefix: "celld-image-archives-test-",
          });
          yield* docker.materialize({
            context,
            dockerfile: "FROM scratch\nCOPY payload.txt /payload.txt\n",
            files: [
              {
                path: "payload.txt",
                content: "Celld native archive publication fixture\n",
              },
            ],
          });
          const declarations: ContainerDeclaration[] = [
            {
              name: "Tiny",
              className: "Tool",
              image: path.join(context, "Dockerfile"),
              ociRuntime: "runsc",
              instanceType: "dev",
              maxInstances: 4,
            },
          ];
          const prepared = yield* prepareContainerImages({
            declarations,
            platform,
            archiveDirectory,
          });
          expect(prepared.containers).toHaveLength(1);
          expect(prepared.images).toHaveLength(2);
          expect(prepared.fenceImage).toMatch(/^celld-image:[a-f0-9]{64}$/);
          const artifacts = yield* Effect.forEach(prepared.images, (artifact) =>
            Effect.gen(function* () {
              const inspected = yield* docker.run([
                "image",
                "inspect",
                "--format",
                "{{json .RootFS.Layers}}{{json .Config}}",
                artifact.image,
              ]);
              const identity = yield* sha256(inspected.stdout.trim());
              const body = yield* fs.readFile(artifact.path);
              const checksum = yield* sha256(body);
              expect(artifact.image).toBe(`celld-image:${identity}`);
              expect(artifact.key).toBe(`deploy/images/${identity}.tar`);
              expect(body.length).toBeGreaterThan(0);
              expect(checksum).not.toBe(identity);
              const archiveManifest = yield* spawner.string(
                ChildProcess.make("tar", [
                  "-xOf",
                  artifact.path,
                  "manifest.json",
                ]),
              );
              const entries = yield* decodeManifest(archiveManifest);
              expect(entries.flatMap((entry) => entry.RepoTags)).toContain(
                artifact.image,
              );
              yield* Effect.logInfo(
                JSON.stringify({
                  platform,
                  image: artifact.image,
                  key: artifact.key,
                  sha256: checksum,
                  bytes: body.length,
                }),
              );
              return {
                image: artifact.image,
                key: artifact.key,
                sha256: checksum,
                bytes: body.length,
                body,
              };
            }),
          );
          const native = yield* deploymentMetadata({
            scriptName: "container-image-test",
            mainModule: "worker.js",
            compatibilityDate: "2026-09-01",
            compatibilityFlags: [],
            bindings: [],
            durableObjects: [{ name: "Tool", className: "Tool" }],
            vars: {},
            queueConsumers: [],
          });
          const { store, writes, objects } = yield* makeStore;
          const selected = yield* stageContainerArtifacts(store, artifacts);
          const deployment = yield* prepareDeployment({
            scriptName: "container-image-test",
            mainModule: "worker.js",
            modules: [
              {
                name: "worker.js",
                content: "export class Tool {}\nexport default {};",
              },
            ],
            ...native,
            containers: prepared.containers,
            fenceImage: prepared.fenceImage,
            containerArtifacts: selected,
          });
          yield* stageDeployment(store, deployment);
          for (const artifact of artifacts) {
            expect(writes.indexOf(artifact.key)).toBeLessThan(
              writes.indexOf(deployment.candidate.key),
            );
          }
          const written = [...writes];
          const repeated = yield* prepareContainerImages({
            declarations,
            platform,
            archiveDirectory: yield* fs.makeTempDirectoryScoped({
              prefix: "celld-rebuilt-archives-test-",
            }),
          });
          expect(repeated.containers).toEqual(prepared.containers);
          expect(repeated.fenceImage).toBe(prepared.fenceImage);
          const rebuiltArchives = yield* Effect.forEach(
            repeated.images,
            (artifact) =>
              Effect.gen(function* () {
                const body = yield* fs.readFile(artifact.path);
                const checksum = yield* sha256(body);
                yield* Effect.logInfo(
                  JSON.stringify({
                    rebuild: true,
                    image: artifact.image,
                    sha256: checksum,
                    bytes: body.length,
                  }),
                );
                return {
                  image: artifact.image,
                  key: artifact.key,
                  sha256: checksum,
                  bytes: body.length,
                  body,
                };
              }),
          );
          const reused = yield* stageContainerArtifacts(store, rebuiltArchives);
          expect(reused).toEqual(selected);
          const next = yield* prepareDeployment({
            scriptName: "container-image-test",
            mainModule: "worker.js",
            modules: [
              {
                name: "worker.js",
                content: "export class Tool {}\nexport default {};",
              },
            ],
            ...native,
            containers: repeated.containers,
            fenceImage: repeated.fenceImage,
            containerArtifacts: reused,
          });
          yield* stageDeployment(store, next);
          expect(next.artifactDescriptor).toEqual(
            deployment.artifactDescriptor,
          );
          expect(writes).toEqual(written);
          for (const artifact of artifacts)
            expect(objects.get(artifact.key)?.body).toEqual(artifact.body);
          expect(writes.some((key) => key.endsWith("current.json"))).toBe(
            false,
          );
          expect(deployment.manifest.containers).toEqual(prepared.containers);
          expect(deployment.manifest.fence_image).toBe(prepared.fenceImage);
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 120_000 },
    );
  },
);
