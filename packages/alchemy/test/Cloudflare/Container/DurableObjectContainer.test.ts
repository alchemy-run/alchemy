import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare";
import { DockerLive } from "@/Docker/Docker.ts";
import * as Test from "@/Test/Alchemy";
import { NativeImages, nativeStack } from "./fixtures/native/stack.ts";

/** What `/probe` reports about the running container (fixtures/native). */
interface Probe {
  wasRunning: boolean;
  /** The image reference the object asked to start. */
  configured: string;
  /** The image reference the runtime reports as running. */
  inspected: string | undefined;
  /** `/etc/alpine-release` inside the container. */
  release: string;
  /** Contents of the seeded file, "" when absent. */
  file: string;
  /** The Durable Object storage marker, null when absent. */
  stored: string | null;
}

interface Metadata {
  id: string;
  incarnation: string;
  images: Record<string, string>;
  stored: string | null;
}

interface ExecResult {
  stdout: string;
  exitCode: number;
  images: string[];
}

/** GET a route; a non-2xx response fails with its status and body. */
const getText = (baseUrl: string, path: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(new URL(path, baseUrl));
    const body = yield* response.text;
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(new Error(`GET ${path} failed (${response.status}): ${body}`));
    }
    return body;
  });

const getJson = <A>(baseUrl: string, path: string) =>
  Effect.map(getText(baseUrl, path), (body) => JSON.parse(body) as A);

/** A fresh workers.dev URL needs a few seconds before it routes requests. */
const waitUntilReady = (url: string) =>
  getText(url, "/ready").pipe(
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
    Effect.timeout("25 seconds"),
  );

/**
 * Probes start, restart, and write to containers, so they are never retried.
 * Query flags: `seed` writes the marker file and storage, `restart` destroys
 * the running container first, `image=<name>` picks the image to start.
 */
const probe = (url: string, query = "") =>
  getJson<Probe>(url, `/probe${query}`).pipe(Effect.timeout("25 seconds"));

const readMetadata = (url: string, query = "") =>
  getJson<Metadata>(url, `/metadata${query}`).pipe(Effect.timeout("10 seconds"));

/** The `containers` metadata of a Worker's most recently uploaded version. */
const uploadedContainers = Effect.fn(function* (accountId: string, scriptName: string) {
  const versions = yield* Workers.listScriptVersions({ accountId, scriptName });
  const latest = versions.items?.toSorted((a, b) => (b.number ?? 0) - (a.number ?? 0))[0];
  if (!latest?.id) {
    return yield* Effect.die(`Worker ${scriptName} has no uploaded version.`);
  }
  const version = yield* Workers.getScriptVersion({
    accountId,
    scriptName,
    versionId: latest.id,
  });
  return version.resources.scriptRuntime?.containers;
});

const waitForApplicationDeleted = (accountId: string, applicationId: string) =>
  Containers.getContainerApplication({ accountId, applicationId }).pipe(
    Effect.catchTag("ContainerApplicationNotFound", () => Effect.succeed(undefined)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (application) => application === undefined,
      times: 8,
    }),
  );

for (const dev of [true, false]) {
  describe(
    `Durable Object containers (dev: ${dev})`,
    {
      tags: ["provider:cloudflare", "provider:cloudflare:container", dev ? "local" : "live"],
    },
    () => {
      const { test } = Test.make({
        providers: Layer.mergeAll(Cloudflare.providers(), DockerLive),
        dev,
        stage: dev ? "test-native-local" : "test-native-live",
      });

      // TODO: Investigate image-map propagation after same-name image updates.
      // Live Alpine 3.21 -> 3.20 updates uploaded the correct Worker metadata,
      // but existing DOs still exposed the old ctx.container.images map even
      // after observing the new environment revision. Fresh DOs were mixed:
      // the Effect fixture saw the new map, while the async fixture saw the old.
      // abort() demonstrably recreated both original DOs (new incarnation,
      // same DO ID and preserved storage), but refreshed only the async map.
      // Alpine <-> Debian passed locally and live, including external-image
      // publication. Local Alpine replacement also passed. No root cause yet;
      // eviction alone is not a reliable remedy. Keep these assertions intact.
      test.provider.todo(
        "preserves state across redeploys and selects replaced named images",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const initialImages = {
              shell: { image: "alpine:3.21" },
              tools: { image: "alpine:3.20" },
            };
            // Swap the two images under the same names.
            const replacementImages = {
              shell: { image: "alpine:3.20" },
              tools: { image: "alpine:3.21" },
            };
            const stackWith = (images: typeof initialImages) =>
              nativeStack.pipe(Effect.provideService(NativeImages, images));

            /** Seed state into each object, and check both images start. */
            const seed = Effect.fn(function* (url: string) {
              const shell = yield* probe(url, "?seed");
              expect(shell.release).toMatch(/^3\.21\./);
              expect(shell.file).toBe("writable");
              expect(shell.stored).toBe("durable");

              const tools = yield* probe(url, "?restart&image=tools");
              expect(tools.release).toMatch(/^3\.20\./);
              expect(tools.file).toBe("");
              expect(tools.stored).toBe("durable");

              // Leave the shell image running with the seeded file.
              yield* probe(url, "?restart&seed");
            });

            const verifyReplacedImages = Effect.fn(function* (
              worker: { url: string | undefined; workerName: string },
              application: Cloudflare.Containers.ContainerApplication["Attributes"],
            ) {
              const url = worker.url!;

              // Wait for the new Worker version to reach this object.
              const expectedRevision = JSON.stringify(replacementImages);
              const revision = yield* getText(url, "/revision").pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("1 second"),
                  until: (value) => value === expectedRevision,
                  times: 8,
                }),
                Effect.timeout("15 seconds"),
              );
              expect(revision).toBe(expectedRevision);

              const existing = yield* readMetadata(url);
              const fresh = yield* readMetadata(url, "?object=fresh-after-update");
              const uploaded = dev
                ? undefined
                : yield* uploadedContainers(application.accountId, worker.workerName);
              yield* Effect.logInfo("Image metadata before eviction", {
                worker: worker.workerName,
                expected: application.images,
                uploaded,
                existing,
                fresh,
              });

              // abort() fails the request by design; a new incarnation on
              // the next read proves the object was evicted.
              yield* getText(url, "/evict").pipe(Effect.ignore);
              const evicted = yield* readMetadata(url).pipe(
                Effect.retry({
                  schedule: Schedule.spaced("1 second"),
                  times: 3,
                }),
              );
              yield* Effect.logInfo("Image metadata after eviction", {
                worker: worker.workerName,
                evicted,
              });
              expect(evicted.id).toBe(existing.id);
              expect(evicted.incarnation).not.toBe(existing.incarnation);
              expect(evicted.stored).toBe("durable");
              expect(fresh.id).not.toBe(existing.id);
              expect(fresh.stored).toBeNull();

              // Updating declarations must not replace a running container.
              // Local hot reload restarts workerd, so only production keeps
              // the running container.
              const beforeRestart = yield* probe(url);
              yield* Effect.logInfo("Container replacement before restart", beforeRestart);
              expect(beforeRestart.stored).toBe("durable");
              if (!dev) {
                expect(beforeRestart.configured).toBe(application.images?.shell);
                expect(beforeRestart).toMatchObject({
                  wasRunning: true,
                  release: expect.stringMatching(/^3\.21\./),
                  file: "writable",
                  stored: "durable",
                });
              }

              // A restart picks up the replaced image under the same name.
              const afterRestart = yield* probe(url, "?restart");
              yield* Effect.logInfo("Container replacement after restart", afterRestart);
              if (!dev) {
                expect(afterRestart.inspected).toBe(afterRestart.configured);
              }
              expect(afterRestart.release).toMatch(/^3\.20\./);
              expect(afterRestart.file).toBe("");
              expect(afterRestart.stored).toBe("durable");

              const tools = yield* probe(url, "?restart&image=tools");
              expect(tools.release).toMatch(/^3\.21\./);
              expect(tools.stored).toBe("durable");
            });

            yield* Effect.gen(function* () {
              const initial = yield* stack.deploy(stackWith(initialImages));
              const initialWorkers = [initial.worker, initial.asyncWorker];
              for (const worker of initialWorkers) {
                yield* waitUntilReady(worker.url!);
              }
              yield* Effect.forEach(initialWorkers, (worker) => seed(worker.url!), {
                concurrency: 2,
              });

              // An unchanged redeploy keeps the running container and state.
              const unchanged = yield* stack.deploy(stackWith(initialImages));
              for (const worker of [unchanged.worker, unchanged.asyncWorker]) {
                expect(yield* probe(worker.url!)).toMatchObject({
                  wasRunning: true,
                  release: expect.stringMatching(/^3\.21\./),
                  file: "writable",
                  stored: "durable",
                });
              }

              // Replacing images exercises external-image publication on update.
              const changed = yield* stack.deploy(stackWith(replacementImages));
              for (const [before, after] of [
                [initial.application, changed.application],
                [initial.asyncApplication, changed.asyncApplication],
              ] as const) {
                expect(after.applicationId).toBe(before.applicationId);
                // Local bindings expose names; cloud bindings expose digests.
                if (!dev) {
                  expect(after.images?.shell).not.toBe(before.images?.shell);
                  expect(after.images?.tools).not.toBe(before.images?.tools);
                }
              }
              yield* Effect.all(
                [
                  verifyReplacedImages(changed.worker, changed.application),
                  verifyReplacedImages(changed.asyncWorker, changed.asyncApplication),
                ],
                { concurrency: 2 },
              );
            }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
          }),
        { timeout: 120_000, retry: 0 },
      );

      test.provider(
        "deploys native Effect and async containers without fleet settings",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            /** Exec routes are safe to retry while a new Worker comes up. */
            const exec = (url: string, path: string) =>
              getJson<ExecResult>(url, path).pipe(
                Effect.retry({
                  schedule: Schedule.spaced("1 second"),
                  times: 8,
                }),
                Effect.timeout("25 seconds"),
              );

            const applications = yield* Effect.gen(function* () {
              const deployed = yield* stack.deploy(nativeStack);

              for (const worker of [deployed.asyncWorker, deployed.worker]) {
                const url = worker.url!;
                yield* waitUntilReady(url);
                expect(yield* exec(url, "/exec")).toEqual({
                  stdout: "native",
                  exitCode: 7,
                  images: ["shell"],
                });
                expect(yield* exec(url, "/stdin")).toEqual({
                  stdout: "native stdin",
                  exitCode: 0,
                  images: ["shell"],
                });
              }
              expect(yield* exec(deployed.worker.url!, "/snapshot")).toEqual({
                stdout: "persisted",
                exitCode: 0,
                images: ["shell"],
              });

              if (!dev) {
                // The applications exist without any fleet configuration.
                for (const application of [deployed.application, deployed.asyncApplication]) {
                  const observed = yield* Containers.getContainerApplication({
                    accountId: application.accountId,
                    applicationId: application.applicationId,
                  });
                  expect(observed.schedulingPolicy).toBe("durable_object");
                  expect(observed.id).toBe(observed.durableObjects?.namespaceId);
                  expect(observed.configuration.image).toBeUndefined();
                  expect(observed.maxInstances ?? undefined).toBeUndefined();
                }
                expect(yield* exec(deployed.asyncWorker.url!, "/builtin")).toEqual({
                  stdout: "native",
                  exitCode: 7,
                  images: ["shell"],
                });
              }

              const unchanged = yield* stack.deploy(nativeStack);
              expect(unchanged.application.applicationId).toBe(deployed.application.applicationId);

              // Adding a named image updates the Worker in place.
              const named = yield* stack.deploy(
                nativeStack.pipe(
                  Effect.provideService(NativeImages, {
                    shell: { image: "alpine:3.21" },
                    tools: { image: "alpine:3.21" },
                  }),
                ),
              );
              const imageNames = (images: object | null | undefined) =>
                Object.keys(images ?? {}).sort();
              expect(imageNames(named.asyncApplication.images)).toEqual(["shell", "tools"]);
              expect(imageNames(named.asyncApplication.devImages)).toEqual(["shell", "tools"]);
              if (!dev) {
                const containers = yield* uploadedContainers(
                  named.asyncApplication.accountId,
                  named.asyncWorker.workerName,
                );
                const uploaded = containers?.find(
                  (container) => container.className === "NativeAsyncObject",
                );
                expect(imageNames(uploaded?.images)).toEqual(["shell", "tools"]);
              }
              expect(yield* exec(named.asyncWorker.url!, "/image/tools")).toEqual({
                stdout: "native",
                exitCode: 7,
                images: ["shell", "tools"],
              });

              // Removing every named image leaves only managed images.
              const updated = yield* stack.deploy(
                nativeStack.pipe(Effect.provideService(NativeImages, {})),
              );
              expect(updated.asyncApplication.applicationId).toBe(
                deployed.asyncApplication.applicationId,
              );
              expect(updated.asyncApplication.images).toEqual({});
              expect(yield* exec(updated.asyncWorker.url!, "/builtin-updated")).toEqual({
                stdout: "native",
                exitCode: 7,
                images: [],
              });

              return [deployed.application, deployed.asyncApplication];
            }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));

            if (!dev) {
              for (const application of applications) {
                expect(
                  yield* waitForApplicationDeleted(
                    application.accountId,
                    application.applicationId,
                  ),
                ).toBeUndefined();
              }
            }
          }),
        { timeout: 120_000, retry: 0 },
      );
    },
  );
}
