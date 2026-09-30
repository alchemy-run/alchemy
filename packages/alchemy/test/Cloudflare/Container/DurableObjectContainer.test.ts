import * as Cloudflare from "@/Cloudflare";
import { DockerLive } from "@/Docker/Docker.ts";
import * as Test from "@/Test/Alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { NativeImages, nativeStack } from "./fixtures/native/stack.ts";

for (const dev of [true, false]) {
  describe(
    `Durable Object containers (dev: ${dev})`,
    {
      tags: [
        "provider:cloudflare",
        "provider:cloudflare:container",
        dev ? "local" : "live",
      ],
    },
    () => {
      const { test } = Test.make({
        providers: Layer.mergeAll(Cloudflare.providers(), DockerLive),
        dev,
        stage: dev ? "test-native-local" : "test-native-live",
      });
      test.provider(
        "deploys native Effect and async containers without fleet settings",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const applications = yield* Effect.gen(function* () {
              const deployed = yield* stack.deploy(nativeStack);
              const client = yield* HttpClient.HttpClient;
              const getJson = (url: URL) =>
                client.get(url).pipe(
                  Effect.flatMap(HttpClientResponse.filterStatusOk),
                  Effect.retry({
                    schedule: Schedule.spaced("1 second"),
                    times: 8,
                  }),
                  Effect.flatMap((response) => response.json),
                  Effect.timeout("25 seconds"),
                  Effect.tapError((error) =>
                    Effect.gen(function* () {
                      if (
                        "reason" in error &&
                        error.reason._tag === "StatusCodeError"
                      ) {
                        const body = yield* error.reason.response.text;
                        yield* Effect.logError(
                          `Native container request ${url.pathname} failed: ${body}`,
                        );
                      } else {
                        yield* Effect.logError(
                          `Native container request ${url.pathname} failed`,
                          error,
                        );
                      }
                    }),
                  ),
                );
              for (const worker of [deployed.asyncWorker, deployed.worker]) {
                const url = worker.url!;
                yield* client.get(new URL("/ready", url)).pipe(
                  Effect.flatMap(HttpClientResponse.filterStatusOk),
                  Effect.retry({
                    schedule: Schedule.spaced("2 seconds"),
                    times: 8,
                  }),
                  Effect.timeout("25 seconds"),
                );
                const result = yield* getJson(new URL("/exec", url));
                expect(result).toEqual({
                  stdout: "native",
                  exitCode: 7,
                  images: ["shell"],
                });
                const stdin = yield* getJson(new URL("/stdin", url));
                expect(stdin).toEqual({
                  stdout: "native stdin",
                  exitCode: 0,
                  images: ["shell"],
                });
              }
              const snapshot = yield* getJson(
                new URL("/snapshot", deployed.worker.url!),
              );
              expect(snapshot).toEqual({
                stdout: "persisted",
                exitCode: 0,
                images: ["shell"],
              });

              if (!dev) {
                for (const application of [
                  deployed.application,
                  deployed.asyncApplication,
                ]) {
                  const observed = yield* Containers.getContainerApplication({
                    accountId: application.accountId,
                    applicationId: application.applicationId,
                  });
                  expect(observed.schedulingPolicy).toBe("durable_object");
                  expect(observed.id).toBe(
                    observed.durableObjects?.namespaceId,
                  );
                  expect(observed.configuration.image).toBeUndefined();
                  expect(observed.maxInstances ?? undefined).toBeUndefined();
                }
                const builtin = yield* getJson(
                  new URL("/builtin", deployed.asyncWorker.url!),
                );
                expect(builtin).toEqual({
                  stdout: "native",
                  exitCode: 7,
                  images: ["shell"],
                });
              }
              const unchanged = yield* stack.deploy(nativeStack);
              expect(unchanged.application.applicationId).toBe(
                deployed.application.applicationId,
              );
              const named = yield* stack.deploy(
                nativeStack.pipe(
                  Effect.provideService(NativeImages, {
                    shell: { image: "alpine:3.21" },
                    tools: { image: "alpine:3.21" },
                  }),
                ),
              );
              expect(
                Object.keys(named.asyncApplication.images ?? {}).sort(),
              ).toEqual(["shell", "tools"]);
              expect(
                Object.keys(named.asyncApplication.devImages ?? {}).sort(),
              ).toEqual(["shell", "tools"]);
              if (!dev) {
                const versions = yield* Workers.listScriptVersions({
                  accountId: named.asyncApplication.accountId,
                  scriptName: named.asyncWorker.workerName,
                });
                const latest = versions.items?.toSorted(
                  (a, b) => (b.number ?? 0) - (a.number ?? 0),
                )[0];
                if (!latest?.id) throw new Error("The Worker has no version.");
                const version = yield* Workers.getScriptVersion({
                  accountId: named.asyncApplication.accountId,
                  scriptName: named.asyncWorker.workerName,
                  versionId: latest.id,
                });
                const container =
                  version.resources.scriptRuntime?.containers?.find(
                    (container) => container.className === "NativeAsyncObject",
                  );
                expect(Object.keys(container?.images ?? {}).sort()).toEqual([
                  "shell",
                  "tools",
                ]);
              }
              const addedImage = yield* getJson(
                new URL("/image/tools", named.asyncWorker.url!),
              );
              expect(addedImage).toEqual({
                stdout: "native",
                exitCode: 7,
                images: ["shell", "tools"],
              });
              const updated = yield* stack.deploy(
                nativeStack.pipe(Effect.provideService(NativeImages, {})),
              );
              expect(updated.asyncApplication.applicationId).toBe(
                deployed.asyncApplication.applicationId,
              );
              expect(updated.asyncApplication.images).toEqual({});
              const managed = yield* getJson(
                new URL("/builtin-updated", updated.asyncWorker.url!),
              );
              expect(managed).toEqual({
                stdout: "native",
                exitCode: 7,
                images: [],
              });
              return [deployed.application, deployed.asyncApplication];
            }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
            if (!dev) {
              for (const application of applications) {
                const deleted = yield* Containers.getContainerApplication({
                  accountId: application.accountId,
                  applicationId: application.applicationId,
                }).pipe(
                  Effect.catchTag("ContainerApplicationNotFound", () =>
                    Effect.succeed(undefined),
                  ),
                  Effect.repeat({
                    schedule: Schedule.spaced("1 second"),
                    until: (application) => application === undefined,
                    times: 8,
                  }),
                );
                expect(deleted).toBeUndefined();
              }
            }
          }),
        { timeout: 120_000 },
      );
    },
  );
}
