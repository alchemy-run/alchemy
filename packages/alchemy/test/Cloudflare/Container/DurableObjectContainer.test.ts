import * as Cloudflare from "@/Cloudflare";
import { DockerLive } from "@/Docker/Docker.ts";
import * as Test from "@/Test/Alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
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
            yield* Effect.gen(function* () {
              const deployed = yield* stack.deploy(nativeStack);
              const client = yield* HttpClient.HttpClient;
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
                const result = yield* client.get(new URL("/exec", url)).pipe(
                  Effect.flatMap(HttpClientResponse.filterStatusOk),
                  Effect.flatMap((response) => response.json),
                );
                expect(result).toEqual({
                  stdout: "native",
                  exitCode: 7,
                  images: ["shell"],
                });
                const stdin = yield* client.get(new URL("/stdin", url)).pipe(
                  Effect.flatMap(HttpClientResponse.filterStatusOk),
                  Effect.flatMap((response) => response.json),
                );
                expect(stdin).toEqual({
                  stdout: "native stdin",
                  exitCode: 0,
                  images: ["shell"],
                });
              }
              const snapshot = yield* client
                .get(new URL("/snapshot", deployed.worker.url!))
                .pipe(
                  Effect.flatMap(HttpClientResponse.filterStatusOk),
                  Effect.flatMap((response) => response.json),
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
                const builtin = yield* client
                  .get(new URL("/builtin", deployed.asyncWorker.url!))
                  .pipe(
                    Effect.flatMap(HttpClientResponse.filterStatusOk),
                    Effect.flatMap((response) => response.json),
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
              const updated = yield* stack.deploy(
                nativeStack.pipe(Effect.provideService(NativeImages, {})),
              );
              expect(updated.asyncApplication.applicationId).toBe(
                deployed.asyncApplication.applicationId,
              );
              expect(updated.asyncApplication.images).toEqual({});
              const managed = yield* client
                .get(new URL("/builtin-updated", updated.asyncWorker.url!))
                .pipe(
                  Effect.flatMap(HttpClientResponse.filterStatusOk),
                  Effect.flatMap((response) => response.json),
                );
              expect(managed).toEqual({
                stdout: "native",
                exitCode: 7,
                images: [],
              });
            }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
          }),
        { timeout: 120_000 },
      );
    },
  );
}
