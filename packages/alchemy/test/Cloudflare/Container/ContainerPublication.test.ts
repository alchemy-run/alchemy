import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PlatformError, SystemError } from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { retryContainerPublication } from "@/Cloudflare/Containers/ContainerPublication.ts";
import * as Docker from "@/Docker";
import { DockerRegistryBlobUnknown, DockerRegistryUnavailable } from "@/Docker/RegistryError.ts";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { authenticatedRegistry } from "../../Docker/Runtime.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

/**
 * Container images are published through `Docker.Image`. These tests run that
 * publication path for real against a local htpasswd-protected `registry:2`;
 * Cloudflare's own registry is covered by the live ContainerApplication suite.
 */
describe(
  "container image publication",
  {
    tags: ["provider:cloudflare", "provider:cloudflare:container", "provider:docker", "local"],
    concurrent: false,
  },
  () => {
    test.provider(
      "publishes, reuses unchanged content without a builder, and serves a shared repository",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const registry = yield* authenticatedRegistry();
          const context = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-publication-" });
          yield* fs.writeFileString(
            path.join(context, "Dockerfile"),
            "FROM scratch\nCOPY payload /payload\n",
          );
          // Unique bytes per run, so the first publish is never a leftover hit.
          yield* fs.writeFileString(path.join(context, "payload"), context);
          const { username, password } = registry.credentials;
          const image = (id: string) =>
            Docker.Image(id, {
              build: { context, platform: "linux/amd64", options: ["--provenance=false"] },
              publish: {
                repository: `${registry.host}/shared`,
                credentials: { username, password },
              },
            });

          // The image is published and observable through the registry API.
          const web = yield* stack.deploy(image("Web"));
          expect(web.ref).toMatch(new RegExp(`^${registry.host}/shared@sha256:[a-f0-9]{64}$`));
          const digest = web.ref.split("@")[1]!;
          expect(yield* registry.hasManifest("shared", digest)).toBe(true);
          expect(yield* registry.hasManifest("shared", web.hash!)).toBe(true);

          // Unchanged content is a registry cache hit: an unusable builder
          // proves no build or push runs, and the digest is unchanged.
          const deployed = yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              const previous = process.env.BUILDX_BUILDER;
              process.env.BUILDX_BUILDER = "alchemy-publication-must-not-build";
              return previous;
            }),
            // A second application publishing the same content into the shared
            // repository resolves the same immutable image.
            () =>
              stack.deploy(
                Effect.gen(function* () {
                  return { web: yield* image("Web"), api: yield* image("Api") };
                }),
              ),
            (previous) =>
              Effect.sync(() => {
                if (previous === undefined) delete process.env.BUILDX_BUILDER;
                else process.env.BUILDX_BUILDER = previous;
              }),
          );
          expect(deployed.web.ref).toBe(web.ref);
          expect(deployed.api.ref).toBe(web.ref);
          expect(yield* registry.hasManifest("shared", digest)).toBe(true);

          // Published manifests are retained on destroy for other consumers.
          yield* stack.destroy();
          expect(yield* registry.hasManifest("shared", digest)).toBe(true);
        }),
      { exclusive: true, timeout: 120_000 },
    );
  },
);

const cause = new PlatformError(
  new SystemError({
    _tag: "Unknown",
    module: "Docker",
    method: "buildx.build",
    description: "publication failed",
  }),
);

// Retry policy for transient registry failures. A real registry cannot be
// made to return these errors on demand, so the policy is exercised directly.
describe(
  "container publication retries",
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:container", "local"],
  },
  () => {
    for (const error of [
      new DockerRegistryBlobUnknown({ cause }),
      new DockerRegistryUnavailable({ cause }),
    ]) {
      it.effect(
        `recovers from ${error._tag}`,
        () =>
          Effect.gen(function* () {
            let attempts = 0;
            const fiber = yield* Effect.suspend(() =>
              ++attempts < 3 ? Effect.fail(error) : Effect.succeed("published"),
            ).pipe(retryContainerPublication, Effect.forkChild);
            yield* TestClock.adjust("15 seconds");
            expect(yield* Fiber.join(fiber)).toBe("published");
            expect(attempts).toBe(3);
          }),
        { tags: ["provider:docker", "provider:docker:registry"] },
      );

      it.effect(
        `bounds retries for ${error._tag}`,
        () =>
          Effect.gen(function* () {
            let attempts = 0;
            const fiber = yield* Effect.suspend(() => {
              attempts++;
              return Effect.fail(error);
            }).pipe(retryContainerPublication, Effect.flip, Effect.forkChild);
            yield* TestClock.adjust("1 minute");
            expect(yield* Fiber.join(fiber)).toBe(error);
            expect(attempts).toBe(6);
          }),
        { tags: ["provider:docker", "provider:docker:registry"] },
      );
    }

    it.effect("propagates other Docker errors without retrying", () =>
      Effect.gen(function* () {
        let attempts = 0;
        const error = yield* Effect.suspend(() => {
          attempts++;
          return Effect.fail(cause);
        }).pipe(retryContainerPublication, Effect.flip);
        expect(error).toBe(cause);
        expect(attempts).toBe(1);
      }),
    );
  },
);
